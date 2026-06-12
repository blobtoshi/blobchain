// Outbound peer manager. Each peer is just another full node, so we connect

// to them as a WebSocket client of their /ws endpoint and speak the same

// protocol the browser/desktop wallet uses. On (re)connect we:

//   1. Read their `hello` to learn their tip.

//   2. If they're ahead, page through `getBlocks` until we catch up.

//   3. `subscribe` so we receive their gossip.

//

// All inbound things from peers (newBlock / newTx / newEntry) are forwarded

// into the same ingest pipeline used by client submissions, ensuring identical

// validation rules everywhere.

//

// Design choices:

//   - Outbound only - we don't dial random IPs. Bootstrap list via env PEERS.

//   - We're also an inbound WS server, so two nodes with each other in their

//     PEERS list end up with two sockets between them. That's wasteful but

//     not broken; dedup is a Phase 4 concern.

//   - No DHT/auto-discovery. Operators paste each other's URLs.



import WebSocket from "ws";

import { createHash } from "node:crypto";

import type { DB } from "./db.js";

import { ingestBlock, ingestEntry, ingestTx } from "./ingest.js";

import type { ServerMsg, ClientMsg, Block } from "../wsProtocol.js";
import { hostOf, hostAllowed, makeAuth, verifyHandshake } from "./peerAuth.js";



const HEARTBEAT_MS = 20_000;

const STALL_MS = 60_000;

const BASE_BACKOFF_MS = 1_000;

const MAX_BACKOFF_MS = 30_000;

const SYNC_PAGE = 100;

// H1: hard cap on total peers to bound memory / FD growth from peerIdentify spam.
const MAX_PEERS = 32;



export type PeerInfo = {

  url: string;

  state: "connecting" | "open" | "syncing" | "closed";

  remoteNodeId: string | null;

  remoteHeight: number;

  latencyMs: number | null;

  connectedSince: number | null;

  lastMessageAt: number | null;

};



type Peer = PeerInfo & {

  ws: WebSocket | null;

  attempt: number;

  pingTimer: NodeJS.Timeout | null;

  reconnectTimer: NodeJS.Timeout | null;

  lastPingAt: number;

  closed: boolean;
  authenticated: boolean;

};



export type PeerManagerOpts = {

  bootstrapUrls: string[];

  // H1: hosts permitted to be dialed / trusted (PEER_ALLOWLIST). Bootstrap
  // peer hosts are auto-added. `nodeKey` is the shared secret for the signed
  // peer handshake; when set, a peer must present a valid auth token before we
  // ingest any of its blocks.
  allowlist?: Set<string>;

  nodeKey?: string;

  db: DB;

  // The public WebSocket URL other nodes can dial to reach us. Used for

  // auto-mesh: when we dial a peer, we send our own URL so the peer can

  // add a return connection. Also used to ignore self-loops.

  selfUrl?: string;

  // This node's identifier - sent in peerIdentify so peers can ignore

  // duplicate connections from the same node.

  nodeId: string;

  // Called when a new block has been applied via peer ingest, so the local

  // server can re-broadcast to its own subscribers.

  onAppliedBlock?: (b: Block) => void;

  // Called for any new tx/entry the local server should re-gossip.

  onAppliedTx?: (msg: ServerMsg) => void;

  onAppliedEntry?: (msg: ServerMsg) => void;

  // Called when a commit arrives via peer gossip and validates locally.

  onAppliedCommit?: (msg: ServerMsg) => void;

  // Logger.

  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

};



// Stable hash of the current active-block reveal set. Used by the

// state-sync probe to detect divergent peer state and pull missing entries.

// Address-sorted so the hash is independent of insertion order.

function computeActiveStateHashPeer(d: DB, height: number): string {

  const reveals = (d.stmts.getEntriesForHeight.all(height) as any[])

    .slice().sort((a, b) => a.address.localeCompare(b.address));

  const h = createHash("sha256");

  h.update(`h:${height}\n`);

  for (const r of reveals) h.update(`R|${r.address}|${r.score}|${r.signature}\n`);

  return h.digest("hex");

}



export class PeerManager {

  private peers = new Map<string, Peer>();

  // H1: hosts we may dial / trust. Seeded from opts.allowlist + bootstrap hosts.
  private allow = new Set<string>();

  private opts: PeerManagerOpts;



  constructor(opts: PeerManagerOpts) {

    this.opts = opts;

    this.allow = new Set(opts.allowlist ?? []);

    for (const raw of opts.bootstrapUrls) {

      const url = normalize(raw);

      if (!url) continue;

      // Operator explicitly listed this bootstrap peer → trust its host.
      const bh = hostOf(url);

      if (bh) this.allow.add(bh);

      if (this.peers.has(url)) continue;

      this.peers.set(url, this.makePeer(url));

      this.connect(url);

    }

  }



  count(): number {

    let n = 0;

    for (const p of this.peers.values()) if (p.state === "open") n++;

    return n;

  }



  /**

   * Auto-mesh entry point. Called when a peer dials us and identifies itself

   * via peerIdentify. We dial them back so gossip flows in both directions.

   * Idempotent: ignores self-loops, duplicate URLs, and already-connected

   * peers. Safe to call from a request handler.

   */

  addPeer(url: string): void {

    const normalized = normalize(url);

    if (!normalized) return;

    // Don't dial ourselves.

    if (this.opts.selfUrl && normalize(this.opts.selfUrl) === normalized) return;

    // Don't dial duplicates.

    if (this.peers.has(normalized)) return;

    // H1: only dial allowlisted, non-private hosts, and cap total peers. This
    // is what turns peerIdentify from an SSRF / eclipse primitive into a no-op
    // for anything the operator hasn't explicitly trusted.
    if (!hostAllowed(normalized, this.allow)) {
      this.log("warn", `auto-mesh: refused non-allowlisted/private peer ${normalized}`);
      return;
    }

    if (this.peers.size >= MAX_PEERS) {
      this.log("warn", `auto-mesh: peer cap (${MAX_PEERS}) reached, refusing ${normalized}`);
      return;
    }

    this.log("info", `auto-mesh: adding peer ${normalized}`);

    this.peers.set(normalized, this.makePeer(normalized));

    this.connect(normalized);

  }



  /** H1: hosts this node is permitted to dial / trust (for inbound gate checks). */
  allowedHosts(): Set<string> {
    return this.allow;
  }

  list(): PeerInfo[] {

    return Array.from(this.peers.values()).map((p) => ({

      url: p.url, state: p.state,

      remoteNodeId: p.remoteNodeId, remoteHeight: p.remoteHeight,

      latencyMs: p.latencyMs,

      connectedSince: p.connectedSince,

      lastMessageAt: p.lastMessageAt,

    }));

  }



  /** Forward a locally-originated event (sealed block, accepted tx, accepted entry) to all peers. */

  broadcast(msg: ServerMsg) {

    const json = JSON.stringify(msg);

    for (const p of this.peers.values()) {

      if (p.ws && p.ws.readyState === WebSocket.OPEN) {

        try { p.ws.send(json); } catch { /* ignore */ }

      }

    }

  }



  shutdown() {

    for (const p of this.peers.values()) {

      p.closed = true;

      if (p.reconnectTimer) clearTimeout(p.reconnectTimer);

      if (p.pingTimer) clearInterval(p.pingTimer);

      try { p.ws?.close(1001, "shutdown"); } catch { /* ignore */ }

    }

    this.peers.clear();

  }



  // -- Internals -------------------------------------------------------

  private log(level: "info" | "warn" | "error", msg: string, extra?: unknown) {

    this.opts.log?.(level, `[peer] ${msg}`, extra);

  }



  private makePeer(url: string): Peer {

    return {

      url, state: "connecting",

      remoteNodeId: null, remoteHeight: 0, latencyMs: null,

      connectedSince: null, lastMessageAt: null,

      ws: null, attempt: 0, pingTimer: null, reconnectTimer: null,

      lastPingAt: 0, closed: false, authenticated: false,

    };

  }



  private connect(url: string) {

    const p = this.peers.get(url);

    if (!p || p.closed) return;

    p.state = "connecting";

    let ws: WebSocket;

    try {

      ws = new WebSocket(url);

    } catch (e) {

      this.log("warn", `dial failed ${url}`, { err: String(e) });

      this.scheduleReconnect(url);

      return;

    }

    p.ws = ws;



    ws.on("open", () => {

      p.attempt = 0;

      p.connectedSince = Date.now();

      p.state = "open";

      this.log("info", `peer connected ${url}`);

      // Start heartbeat.

      if (p.pingTimer) clearInterval(p.pingTimer);

      p.pingTimer = setInterval(() => this.heartbeat(url), HEARTBEAT_MS);

    });



    ws.on("message", (raw) => {

      p.lastMessageAt = Date.now();

      let msg: ServerMsg;

      try { msg = JSON.parse(raw.toString()); }

      catch { return; }

      this.handleMessage(url, msg).catch((e) =>

        this.log("error", "handler crashed", { err: String(e) }),

      );

    });



    ws.on("close", () => {

      this.log("info", `peer closed ${url}`);

      if (p.pingTimer) { clearInterval(p.pingTimer); p.pingTimer = null; }

      p.ws = null;

      p.state = "closed";

      p.connectedSince = null;

      this.scheduleReconnect(url);

    });



    ws.on("error", (e) => {

      this.log("warn", `peer error ${url}`, { err: String((e as Error)?.message ?? e) });

    });

  }



  private scheduleReconnect(url: string) {

    const p = this.peers.get(url);

    if (!p || p.closed) return;

    if (p.reconnectTimer) return;

    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, p.attempt));

    p.attempt += 1;

    p.reconnectTimer = setTimeout(() => {

      p.reconnectTimer = null;

      this.connect(url);

    }, delay);

  }



  private heartbeat(url: string) {

    const p = this.peers.get(url);

    if (!p || !p.ws || p.ws.readyState !== WebSocket.OPEN) return;

    // Stall detection - no inbound traffic for >STALL_MS -> drop and reconnect.

    if (p.lastMessageAt && Date.now() - p.lastMessageAt > STALL_MS) {

      this.log("warn", `peer stalled ${url}`);

      try { p.ws.close(4000, "stalled"); } catch { /* ignore */ }

      return;

    }

    p.lastPingAt = performance.now();

    this.send(url, { type: "ping", t: Date.now() });

  }



  private send(url: string, msg: ClientMsg) {

    const p = this.peers.get(url);

    if (!p || !p.ws || p.ws.readyState !== WebSocket.OPEN) return;

    try { p.ws.send(JSON.stringify(msg)); } catch { /* ignore */ }

  }



  private async handleMessage(url: string, msg: ServerMsg) {

    const p = this.peers.get(url);

    if (!p) return;

    switch (msg.type) {

      case "hello": {

        p.remoteNodeId = msg.nodeId;

        p.remoteHeight = msg.chainTip.height;

        // H1: authenticate the peer before we will ingest ANY of its blocks.
        // With a shared NODE_KEY, require a valid signed handshake; without one,
        // fall back to allowlist membership (operator-trusted hosts only).
        p.authenticated = this.opts.nodeKey
          ? verifyHandshake(this.opts.nodeKey, msg.auth)
          : this.allow.has(hostOf(url) ?? "");
        if (!p.authenticated) {
          this.log("warn", `peer ${url} not authenticated — its blocks will be ignored`);
        }

        // Auto-mesh: tell the peer who we are so they can dial us back. This

        // is what makes gossip propagate symmetrically without requiring

        // every node to be in every other node's bootstrap list.

        if (this.opts.selfUrl) {

          this.send(url, {

            type: "peerIdentify",

            peerUrl: this.opts.selfUrl,

            nodeId: this.opts.nodeId,

            auth: this.opts.nodeKey ? makeAuth(this.opts.nodeKey, this.opts.nodeId) : undefined,

          } as any);

        }

        await this.syncFromPeer(url, msg.chainTip.height);

        // After sync, subscribe to live gossip.

        this.send(url, { type: "subscribe" });

        // Phase 5: pull the active block's commits + reveals so we converge

        // immediately rather than waiting for the next state-sync probe.

        const tip = this.opts.db.stmts.getTip.get();

        const activeHeight = (tip?.height ?? msg.chainTip.height) + 1;

        this.send(url, { type: "getActiveEntries", height: activeHeight } as any);

        return;

      }

      case "pong": {

        if (p.lastPingAt) p.latencyMs = Math.round(performance.now() - p.lastPingAt);

        return;

      }

      case "chainTip": {

        p.remoteHeight = msg.tip.height;

        return;

      }

      case "newBlock": {

        if (!p.authenticated) return; // H1: never ingest blocks from an unauthenticated peer

        const r = ingestBlock(this.opts.db, msg.block);

        if (r.ok && (r.applied === "appended" || r.applied === "replaced")) {

          p.remoteHeight = Math.max(p.remoteHeight, msg.block.height);

          this.opts.onAppliedBlock?.(msg.block);

        } else if (!r.ok && r.needsResync) {

          // We're behind or forked. Pull a window and try again.

          await this.syncFromPeer(url, msg.block.height);

        }

        return;

      }

      case "newTx": {

        const tx = msg.tx;

        const r = ingestTx(this.opts.db, {

          id: tx.id, nonce: (tx as any).nonce, from: tx.from, to: tx.to, amount: tx.amount,

          feeRate: tx.feeRate, memo: tx.memo,

          signature: tx.signature, publicKey: tx.publicKey, timestamp: tx.timestamp,

        });

        if (r.ok && r.isNew) this.opts.onAppliedTx?.({ type: "newTx", tx: r.tx });

        return;

      }

      case "newEntry": {

        const e = msg.entry;

        // Phase 6: peer must ship the full SubmitEntryPayload so we can

        // re-validate (signature + PoW + simulator + window). Light-only

        // gossip without these fields is rejected.

        if (!e.inputs || !e.inputs_hash || e.frame_count == null

            || e.engine_version == null || !e.pow_nonce || !e.publicKey) {

          return;

        }

        const r = ingestEntry(this.opts.db, {

          address: e.address,

          block_height: e.block_height,

          block_seed: e.block_seed,

          score: e.score,

          frame_count: e.frame_count,

          inputs: e.inputs,

          inputs_hash: e.inputs_hash,

          pow_nonce: e.pow_nonce,

          publicKey: e.publicKey,

          signature: e.signature,

          engine_version: e.engine_version,

        });

        if (r.ok && r.isNewBest) {

          this.opts.onAppliedEntry?.({

            type: "newEntry",

            entry: {

              address: r.address, score: r.score,

              block_height: r.block_height, block_seed: r.block_seed,

              signature: r.signature,

              inputs: e.inputs, inputs_hash: e.inputs_hash,

              frame_count: e.frame_count, engine_version: e.engine_version,

              pow_nonce: e.pow_nonce, publicKey: e.publicKey,

            },

          });

        }

        return;

      }

      case "newEntryCommit": {

        // Phase 6: commits are gone. Ignore any legacy gossip.

        return;

      }

      case "activeEntries": {

        // Snapshot from a peer in response to our getActiveEntries request

        // OR from a peer whose state hash differed from ours. Each entry is

        // re-validated locally so a malicious peer can't inject forgeries.

        for (const e of msg.reveals ?? []) {

          if (!e.inputs || !e.inputs_hash || e.frame_count == null

              || !e.pow_nonce || !e.publicKey) continue;

          ingestEntry(this.opts.db, {

            address: e.address,

            block_height: e.block_height,

            block_seed: e.block_seed,

            score: e.score,

            frame_count: e.frame_count,

            inputs: e.inputs,

            inputs_hash: e.inputs_hash,

            pow_nonce: e.pow_nonce,

            publicKey: e.publicKey,

            signature: e.signature,

            engine_version: e.engine_version ?? 1,

          });

        }

        return;

      }

      case "activeStateHash": {

        // A peer is telling us their active-set hash. If it differs from

        // ours, ask them for their full set. (We don't reply with our own;

        // they'll send their own probe and we'll respond symmetrically.)

        const localHash = computeActiveStateHashPeer(this.opts.db, msg.height);

        if (localHash !== msg.hash) {

          this.send(url, { type: "getActiveEntries", height: msg.height } as any);

        }

        return;

      }

      case "getActiveEntries": {

        // A peer asked for our active set for a height. Respond directly.

        // Phase 6: commits gone; ship reveals with full validation payload.

        const h = msg.height;

        const reveals = (this.opts.db.stmts.getEntriesForHeight.all(h) as any[]).map((e: any) => ({

          address: e.address,

          score: Number(e.score ?? 0),

          block_height: e.block_height,

          block_seed: e.block_seed,

          signature: e.signature,

          inputs: e.inputs ?? null,

          inputs_hash: e.inputs_hash ?? null,

          frame_count: e.frame_count ?? null,

          engine_version: 1,

          pow_nonce: e.pow_nonce ?? null,

          publicKey: e.public_key ?? null,

        }));

        this.send(url, { type: "activeEntries", height: h, commits: [], reveals } as any);

        return;

      }

      case "blocksRange": {

        if (!p.authenticated) return; // H1: never ingest blocks from an unauthenticated peer

        for (const b of msg.blocks) {

          const r = ingestBlock(this.opts.db, b);

          if (r.ok && (r.applied === "appended" || r.applied === "replaced")) {

            this.opts.onAppliedBlock?.(b);

          }

        }

        return;

      }

    }

  }



  private async syncFromPeer(url: string, peerHeight: number) {

    const p = this.peers.get(url);

    if (!p) return;

    p.state = "syncing";

    let safety = 200;

    while (safety-- > 0) {

      // Re-read local tip every iteration: ingest might have advanced it via

      // the main message handler, or failed to advance it (every block rejected).

      const localTip = this.opts.db.stmts.getTip.get();

      const localHeight = localTip?.height ?? 0;

      if (localHeight >= peerHeight) break;

      const cursor = Math.max(1, localHeight - 5 + 1);

      this.send(url, { type: "getBlocks", fromHeight: cursor, limit: SYNC_PAGE });

      // Wait for the matching blocksRange to land, then check whether the tip

      // actually advanced. If it didn't, we're stuck on a fork and bailing

      // here is correct - logging shows why and the operator can intervene.

      const got = await this.waitForBlocks(url, cursor);

      if (!got || got.length === 0) break;

      const newTip = this.opts.db.stmts.getTip.get();

      const newHeight = newTip?.height ?? 0;

      if (newHeight <= localHeight) {

        this.log("warn", "sync stalled: ingest rejected every block in batch", {

          url, requestedFrom: cursor, batchSize: got.length,

          localHeight, peerHeight,

          firstHash: got[0]?.hash?.slice(0, 12),

          lastHash: got[got.length - 1]?.hash?.slice(0, 12),

        });

        break;

      }

    }

    p.state = "open";

  }



  // Awaits the next `blocksRange` message on this peer's socket.

  private waitForBlocks(url: string, fromHeight: number): Promise<Block[] | null> {

    const p = this.peers.get(url);

    if (!p || !p.ws) return Promise.resolve(null);

    return new Promise((resolve) => {

      const ws = p.ws!;

      const timeout = setTimeout(() => {

        ws.off("message", onMsg);

        resolve(null);

      }, 10_000);

      const onMsg = (raw: WebSocket.RawData) => {

        let msg: ServerMsg;

        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type !== "blocksRange") return;

        clearTimeout(timeout);

        ws.off("message", onMsg);

        resolve(msg.blocks);

      };

      ws.on("message", onMsg);

    });

  }

}



function normalize(raw: string): string | null {

  const u = raw.trim();

  if (!u) return null;

  if (!/^wss?:\/\//.test(u) && !/^https?:\/\//.test(u)) return null;

  // Allow http(s):// shorthand -> ws(s):// + /ws

  if (/^https?:\/\//.test(u)) {

    const ws = u.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";

    return ws;

  }

  return u.replace(/\/$/, "");

}
