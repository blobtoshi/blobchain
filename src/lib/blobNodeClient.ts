// Browser-side client for a BLOB CHAIN full node.
//
// Speaks the wire protocol defined in src/lib/wsProtocol.ts:
//   • REST for cold-start reads (tip / blocks / mempool / fee-info) and as a
//     fallback when the WebSocket is down.
//   • WebSocket (/ws) for live gossip + tx/entry submission.
//
// The class is designed as a long-lived singleton: connect once at boot,
// auto-reconnect with backoff, heartbeat, and on every (re)open it backfills
// any blocks the client missed by paging getBlocks until caught up.

import type {
  Block, Tx, Entry, EntryCommit, ChainTip, ServerMsg, ClientMsg,
  SubmitTxPayload, SubmitEntryPayload,
  SubmitEntryCommitPayload, SubmitEntryRevealPayload,
} from "@/lib/wsProtocol";

export type FeeInfo = {
  recommendedFeeRate: number;
  minFeeRate: number;
  baseFeeRate: number;
};

export type NodeHandlers = {
  onBlock?: (b: Block) => void;
  onTx?: (t: Tx) => void;
  onEntry?: (e: Entry) => void;
  onEntryCommit?: (c: EntryCommit) => void;
  onActiveEntries?: (height: number, commits: EntryCommit[], reveals: Entry[]) => void;
  onTip?: (t: ChainTip) => void;
  onStatus?: (s: NodeStatus) => void;
};

export type NodeStatus =
  | "idle"
  | "connecting"
  | "syncing"
  | "open"
  | "closed"
  | "error";

const SYNC_PAGE = 500;
const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;
const HEARTBEAT_MS = 20_000;

export class BlobNodeClient {
  readonly httpUrl: string;
  readonly wsUrl: string;

  private ws: WebSocket | null = null;
  private status: NodeStatus = "idle";
  private handlers: NodeHandlers = {};
  private localTipHeight = 0;
  private retryAttempt = 0;
  private heartbeatHandle: number | null = null;
  // Periodic active-entries resync. Lets the browser see when the node
  // drops abandoned commits (no per-entry removal event exists yet).
  private activeRefreshHandle: number | null = null;
  private reconnectHandle: number | null = null;
  private explicitlyClosed = false;
  // Pending submit acks keyed by ref. The server replies with
  // { type: "ack", ref, data } or { type: "error", ref, message }.
  private pending = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timeout: number;
  }>();

  constructor(baseUrl: string) {
    // Normalize: strip trailing slash.
    const clean = baseUrl.replace(/\/$/, "");
    this.httpUrl = clean;
    this.wsUrl = clean.replace(/^http/, "ws") + "/ws";
  }

  // ── Lifecycle ────────────────────────────────────────────────────────
  setHandlers(h: NodeHandlers) { this.handlers = h; }

  getStatus(): NodeStatus { return this.status; }

  getTipHeight(): number { return this.localTipHeight; }

  connect() {
    this.explicitlyClosed = false;
    this.openSocket();
  }

  close() {
    this.explicitlyClosed = true;
    this.clearHeartbeat();
    this.clearActiveRefresh();
    if (this.reconnectHandle != null) {
      window.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    try { this.ws?.close(1000, "client closed"); } catch { /* ignore */ }
    this.ws = null;
    this.setStatus("closed");
  }

  // ── REST helpers ─────────────────────────────────────────────────────
  async fetchTip(): Promise<ChainTip | null> {
    try {
      const r = await fetch(`${this.httpUrl}/chain/tip`);
      if (!r.ok) return null;
      return (await r.json()) as ChainTip;
    } catch { return null; }
  }

  async fetchBalance(address: string): Promise<number> {
    try {
      const r = await fetch(`${this.httpUrl}/balance/${encodeURIComponent(address)}`);
      if (!r.ok) return 0;
      const j = await r.json() as { balance: number };
      return Number(j.balance ?? 0);
    } catch { return 0; }
  }

  async fetchAddressTxs(address: string, limit = 200): Promise<any[]> {
    try {
      const r = await fetch(`${this.httpUrl}/address/${encodeURIComponent(address)}/txs?limit=${limit}`);
      if (!r.ok) return [];
      return await r.json() as any[];
    } catch { return []; }
  }

  async fetchStats(): Promise<{ height: number; totalSupply: number; totalTxs: number } | null> {
    try {
      const r = await fetch(`${this.httpUrl}/stats`);
      if (!r.ok) return null;
      return await r.json() as { height: number; totalSupply: number; totalTxs: number };
    } catch { return null; }
  }

  async fetchBlocks(from: number, limit = SYNC_PAGE): Promise<Block[]> {
    try {
      const r = await fetch(`${this.httpUrl}/blocks?from=${from}&limit=${limit}`);
      if (!r.ok) return [];
      return (await r.json()) as Block[];
    } catch { return []; }
  }

  async fetchMempool(): Promise<Tx[]> {
    try {
      const r = await fetch(`${this.httpUrl}/mempool`);
      if (!r.ok) return [];
      return (await r.json()) as Tx[];
    } catch { return []; }
  }

  async fetchFeeInfo(): Promise<FeeInfo | null> {
    try {
      const r = await fetch(`${this.httpUrl}/fee-info`);
      if (!r.ok) return null;
      return (await r.json()) as FeeInfo;
    } catch { return null; }
  }

  // ── Node-only REST endpoints (Phase 3) ───────────────────────────────
  async fetchPeers(): Promise<{ count: number; peers: Array<Record<string, unknown>> } | null> {
    try {
      const r = await fetch(`${this.httpUrl}/peers`);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  async fetchEntries(blockHeight: number): Promise<Entry[]> {
    try {
      // First try the immutable per-block endpoint (works for sealed heights).
      const sealed = await fetch(`${this.httpUrl}/blocks/${blockHeight}/entries`);
      if (sealed.ok) return (await sealed.json()) as Entry[];
      // Fall back to the live entries table for the open height.
      const live = await fetch(`${this.httpUrl}/entries?height=${blockHeight}`);
      if (!live.ok) return [];
      return (await live.json()) as Entry[];
    } catch { return []; }
  }

  async fetchAddresses(limit = 2000, offset = 0): Promise<Array<Record<string, unknown>>> {
    try {
      const r = await fetch(`${this.httpUrl}/addresses?limit=${limit}&offset=${offset}`);
      if (!r.ok) return [];
      return await r.json();
    } catch { return []; }
  }

  async registerAddress(p: { address: string; publicKey: string; signature: string; timestamp: number }): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${this.httpUrl}/addresses/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j?.error ?? `http ${r.status}` };
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  // Bridge endpoints intentionally removed: the bridge is custodial and lives
  // on Supabase edge functions, not on full nodes.

  static async healthcheck(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = window.setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: ctl.signal });
      window.clearTimeout(t);
      return r.ok;
    } catch { return false; }
  }

  // ── WS submissions ───────────────────────────────────────────────────
  submitTx(tx: SubmitTxPayload): Promise<{ id: string; fee: number; bytes: number }> {
    return this.requestAck("submitTx", { type: "submitTx", tx }) as Promise<{ id: string; fee: number; bytes: number }>;
  }

  // Legacy single-shot — kept so old peers don't break, but full nodes will
  // reject it post-Phase-4. New code should use commit + reveal.
  submitEntry(entry: SubmitEntryPayload): Promise<{ score: number; isNewBest: boolean }> {
    return this.requestAck("submitEntry", { type: "submitEntry", entry }) as Promise<{ score: number; isNewBest: boolean }>;
  }

  submitEntryCommit(commit: SubmitEntryCommitPayload): Promise<{ address: string; block_height: number }> {
    return this.requestAck("submitEntryCommit", { type: "submitEntryCommit", commit }) as Promise<{ address: string; block_height: number }>;
  }

  submitEntryReveal(reveal: SubmitEntryRevealPayload): Promise<{ score: number; verified: boolean }> {
    return this.requestAck("submitEntryReveal", { type: "submitEntryReveal", reveal }) as Promise<{ score: number; verified: boolean }>;
  }

  // ── Internals ────────────────────────────────────────────────────────
  private setStatus(s: NodeStatus) {
    if (this.status === s) return;
    this.status = s;
    try { this.handlers.onStatus?.(s); } catch { /* ignore handler errors */ }
  }

  private openSocket() {
    if (this.explicitlyClosed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (e) {
      this.setStatus("error");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retryAttempt = 0;
      this.startHeartbeat();
      this.startActiveRefresh();
      // Sync flow runs after we receive the server's `hello`.
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); }
      catch { return; }
      this.handleServerMsg(msg);
    });

    ws.addEventListener("close", () => {
      this.clearHeartbeat();
      this.clearActiveRefresh();
      this.failPendingAcks(new Error("socket closed"));
      this.ws = null;
      if (this.explicitlyClosed) return;
      this.setStatus("closed");
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // Don't change status here; close handler will follow.
    });
  }

  private scheduleReconnect() {
    if (this.explicitlyClosed) return;
    if (this.reconnectHandle != null) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, this.retryAttempt));
    this.retryAttempt += 1;
    this.reconnectHandle = window.setTimeout(() => {
      this.reconnectHandle = null;
      this.openSocket();
    }, delay);
  }

  private startHeartbeat() {
    this.clearHeartbeat();
    this.heartbeatHandle = window.setInterval(() => {
      this.sendRaw({ type: "ping", t: Date.now() });
    }, HEARTBEAT_MS);
  }

  private clearHeartbeat() {
    if (this.heartbeatHandle != null) {
      window.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  // Refresh the active block's commit + reveal set every 15s. Cheap
  // (one round trip with a tiny payload) and ensures the UI catches up
  // when the node prunes abandoned commits or when an event was missed.
  private startActiveRefresh() {
    this.clearActiveRefresh();
    this.activeRefreshHandle = window.setInterval(() => {
      this.sendRaw({ type: "getActiveEntries", height: this.localTipHeight + 1 } as any);
    }, 15_000);
  }

  private clearActiveRefresh() {
    if (this.activeRefreshHandle != null) {
      window.clearInterval(this.activeRefreshHandle);
      this.activeRefreshHandle = null;
    }
  }

  private sendRaw(msg: ClientMsg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try { ws.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  private requestAck(ref: string, msg: ClientMsg, timeoutMs = 15_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("socket not open"));
        return;
      }
      const timeout = window.setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error(`${ref} ack timeout`));
      }, timeoutMs);
      this.pending.set(ref, { resolve, reject, timeout });
      try { ws.send(JSON.stringify(msg)); }
      catch (e) {
        window.clearTimeout(timeout);
        this.pending.delete(ref);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private resolvePending(ref: string, data: unknown) {
    const p = this.pending.get(ref);
    if (!p) return;
    window.clearTimeout(p.timeout);
    this.pending.delete(ref);
    p.resolve(data);
  }

  private rejectPending(ref: string, message: string) {
    const p = this.pending.get(ref);
    if (!p) return;
    window.clearTimeout(p.timeout);
    this.pending.delete(ref);
    p.reject(new Error(message));
  }

  private failPendingAcks(err: Error) {
    for (const [ref, p] of this.pending) {
      window.clearTimeout(p.timeout);
      p.reject(err);
      this.pending.delete(ref);
    }
  }

  private async handleServerMsg(msg: ServerMsg) {
    switch (msg.type) {
      case "hello": {
        const serverTip = msg.chainTip.height;
        // Backfill missing blocks, then subscribe.
        await this.syncFrom(this.localTipHeight + 1, serverTip);
        this.localTipHeight = Math.max(this.localTipHeight, serverTip);
        this.handlers.onTip?.(msg.chainTip);
        this.sendRaw({ type: "subscribe" });
        // Phase 5: pull current active block's commits + reveals so the UI
        // shows the full set immediately, not just events from this session.
        this.sendRaw({ type: "getActiveEntries", height: serverTip + 1 } as any);
        this.setStatus("open");
        return;
      }
      case "pong":
        return;
      case "newBlock":
        this.localTipHeight = Math.max(this.localTipHeight, msg.block.height);
        this.handlers.onBlock?.(msg.block);
        return;
      case "newTx":
        this.handlers.onTx?.(msg.tx);
        return;
      case "newEntry":
        this.handlers.onEntry?.(msg.entry);
        return;
      case "newEntryCommit":
        this.handlers.onEntryCommit?.(msg.commit);
        return;
      case "activeEntries":
        this.handlers.onActiveEntries?.(msg.height, msg.commits, msg.reveals);
        return;
      case "activeStateHash":
        // Server-pushed state hash — useful for diagnostics, not actionable
        // by browser clients (which can't independently re-request).
        return;
      case "chainTip":
        this.localTipHeight = Math.max(this.localTipHeight, msg.tip.height);
        this.handlers.onTip?.(msg.tip);
        return;
      case "blocksRange":
        for (const b of msg.blocks) {
          this.localTipHeight = Math.max(this.localTipHeight, b.height);
          this.handlers.onBlock?.(b);
        }
        return;
      case "mempool":
        for (const t of msg.txs) this.handlers.onTx?.(t);
        return;
      case "ack":
        if (msg.ref) this.resolvePending(msg.ref, msg.data);
        return;
      case "error":
        if (msg.ref) this.rejectPending(msg.ref, msg.message);
        return;
    }
  }

  private async syncFrom(fromHeight: number, toHeight: number) {
    if (fromHeight > toHeight) return;
    // Cap to last 500 blocks. Server-side endpoints (/balance, /addresses,
    // /address/:addr/txs, /stats) provide accurate aggregates and history,
    // so the frontend doesn't need the full chain in memory.
    const cappedFrom = Math.max(fromHeight, toHeight - SYNC_PAGE + 1);
    this.setStatus("syncing");
    let cursor = cappedFrom;
    let safety = 20;
    while (cursor <= toHeight && safety-- > 0) {
      const blocks = await this.fetchBlocks(cursor, SYNC_PAGE);
      if (blocks.length === 0) break;
      for (const b of blocks) {
        this.localTipHeight = Math.max(this.localTipHeight, b.height);
        try { this.handlers.onBlock?.(b); } catch { /* ignore */ }
      }
      cursor = blocks[blocks.length - 1].height + 1;
    }
  }
}