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
//   • Outbound only — we don't dial random IPs. Bootstrap list via env PEERS.
//   • We're also an inbound WS server, so two nodes with each other in their
//     PEERS list end up with two sockets between them. That's wasteful but
//     not broken; dedup is a Phase 4 concern.
//   • No DHT/auto-discovery. Operators paste each other's URLs.

import WebSocket from "ws";
import type { DB } from "./db.js";
import { ingestBlock, ingestEntry, ingestTx } from "./ingest.js";
import type { ServerMsg, ClientMsg, Block } from "../wsProtocol.js";

const HEARTBEAT_MS = 20_000;
const STALL_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const SYNC_PAGE = 100;

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
};

export type PeerManagerOpts = {
  bootstrapUrls: string[];
  db: DB;
  // Called when a new block has been applied via peer ingest, so the local
  // server can re-broadcast to its own subscribers.
  onAppliedBlock?: (b: Block) => void;
  // Called for any new tx/entry the local server should re-gossip.
  onAppliedTx?: (msg: ServerMsg) => void;
  onAppliedEntry?: (msg: ServerMsg) => void;
  // Logger.
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
  // For sending newBlock / newTx / newEntry we just sealed/received locally
  // back out to peers. Returns the message to forward (or null to skip).
  // Actually we just expose `broadcast` from outside.
};

export class PeerManager {
  private peers = new Map<string, Peer>();
  private opts: PeerManagerOpts;

  constructor(opts: PeerManagerOpts) {
    this.opts = opts;
    for (const raw of opts.bootstrapUrls) {
      const url = normalize(raw);
      if (!url) continue;
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

  // ── Internals ───────────────────────────────────────────────────────
  private log(level: "info" | "warn" | "error", msg: string, extra?: unknown) {
    this.opts.log?.(level, `[peer] ${msg}`, extra);
  }

  private makePeer(url: string): Peer {
    return {
      url, state: "connecting",
      remoteNodeId: null, remoteHeight: 0, latencyMs: null,
      connectedSince: null, lastMessageAt: null,
      ws: null, attempt: 0, pingTimer: null, reconnectTimer: null,
      lastPingAt: 0, closed: false,
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
    // Stall detection — no inbound traffic for >STALL_MS → drop and reconnect.
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
        await this.syncFromPeer(url, msg.chainTip.height);
        // After sync, subscribe to live gossip.
        this.send(url, { type: "subscribe" });
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
          id: tx.id, from: tx.from, to: tx.to, amount: tx.amount,
          feeRate: tx.feeRate, memo: tx.memo,
          signature: tx.signature, publicKey: tx.publicKey, timestamp: tx.timestamp,
        });
        if (r.ok && r.isNew) this.opts.onAppliedTx?.({ type: "newTx", tx: r.tx });
        return;
      }
      case "newEntry": {
        const e = msg.entry;
        if (!e.inputs || !e.inputs_hash || e.frame_count == null || e.engine_version == null) {
          // Light entry gossip without full replay payload — ignore for now.
          return;
        }
        const r = ingestEntry(this.opts.db, {
          address: e.address, score: e.score,
          block_height: e.block_height, block_seed: e.block_seed,
          signature: e.signature, publicKey: "", // peers don't ship publicKey separately
          inputs: e.inputs, inputs_hash: e.inputs_hash,
          frame_count: e.frame_count, engine_version: e.engine_version,
        });
        if (r.ok && r.isNewBest) {
          this.opts.onAppliedEntry?.({
            type: "newEntry",
            entry: { address: r.address, score: r.score, block_height: r.block_height,
              block_seed: r.block_seed, signature: r.signature },
          });
        }
        return;
      }
      case "blocksRange": {
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
    const localTip = this.opts.db.stmts.getTip.get();
    const localHeight = localTip?.height ?? 0;
    let cursor = Math.max(1, localHeight - 5 + 1); // pull a small back-window so we can heal a depth-1 reorg
    let safety = 200;
    while (cursor <= peerHeight && safety-- > 0) {
      this.send(url, { type: "getBlocks", fromHeight: cursor, limit: SYNC_PAGE });
      // Wait for the matching blocksRange to land, then continue.
      const got = await this.waitForBlocks(url, cursor);
      if (!got || got.length === 0) break;
      const last = got[got.length - 1].height;
      if (last < cursor) break;
      cursor = last + 1;
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
  // Allow http(s):// shorthand → ws(s):// + /ws
  if (/^https?:\/\//.test(u)) {
    const ws = u.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
    return ws;
  }
  return u.replace(/\/$/, "");
}
