// Blob Chain relay — node-only, with multi-node failover via nodePool.
//
// All chain reads/writes go through a BlobNodeClient pointed at the currently
// active full node (lowest-latency healthy, or user-pinned). When the active
// node changes we tear down + rebuild the client so the new URL takes effect.
//
// The bridge (BLOB ↔ Solana) is the ONE exception: it stays on Supabase edge
// functions because it requires custodial Solana key material that can't live
// on a public node. Bridge calls in this file go directly to edge functions.

import { supabase } from "@/integrations/supabase/client";
import { BlobNodeClient } from "@/lib/blobNodeClient";
import { getNodePool, type NodeHealth } from "@/lib/nodePool";
import type { ConsensusSnapshot } from "@/lib/tipConsensus";

export type Block = {
  height: number;
  previousHash: string;
  timestamp: number;
  transactions: any[];
  miningEntries: any[];
  winner: string | null;
  winnerScore?: number;
  reward: number;
  seed: string;
  hash: string;
  totalSupply?: number;
  nodeCount?: number;
};

export type Tx = {
  id: string;
  from: string;
  to: string;
  amount: number;
  fee?: number;
  feeRate?: number;
  memo?: string;
  signature: string;
  publicKey: string;
  timestamp: number;
};

export type FeeInfo = {
  recommendedFeeRate: number;
  minFeeRate: number;
  baseFeeRate: number;
};

export type Entry = {
  address: string;
  score: number;
  block_height: number;
  block_seed?: string | null;
  signature: string;
  inputs?: string;
  inputs_hash?: string;
  frame_count?: number;
  engine_version?: number;
  // True when the miner has only submitted a commit and not yet revealed
  // their score. UI shows the address but hides the score.
  pending?: boolean;
};

// ── Active-node management ──────────────────────────────────────────────
let nodeClient: BlobNodeClient | null = null;
let activeUrl: string | null = null;

const pool = getNodePool();

// Whenever the pool picks a different active node, swap the client.
pool.on((e) => {
  if (e.type !== "active-changed") return;
  const next = e.url;
  if (next === activeUrl) return;
  try { nodeClient?.close?.(); } catch { /* ignore */ }
  nodeClient = next ? new BlobNodeClient(next) : null;
  activeUrl = next;
  emitStatus();
});

// Initialize from current pool state (may already be set if probes finished).
activeUrl = pool.getActive();
if (activeUrl) nodeClient = new BlobNodeClient(activeUrl);

export function getActiveNodeUrl(): string | null { return activeUrl; }
export function getNodeClient(): BlobNodeClient | null { return nodeClient; }
export function getNodeHealth(): NodeHealth[] { return pool.getHealth(); }

export type RelayStatus = {
  activeUrl: string | null;
  health: NodeHealth[];
  pinned: string | null;
  custom: string[];
  // Cross-node tip consensus (eclipse-attack defense). null until the first
  // round runs.
  consensus: ConsensusSnapshot | null;
};

const statusListeners = new Set<(s: RelayStatus) => void>();
function snapshotStatus(): RelayStatus {
  return {
    activeUrl,
    health: pool.getHealth(),
    pinned: pool.getPinned(),
    custom: pool.getCustom(),
    consensus: pool.getConsensus(),
  };
}
function emitStatus() {
  const s = snapshotStatus();
  for (const l of statusListeners) { try { l(s); } catch { /* ignore */ } }
}
pool.on(() => emitStatus());

export function onRelayStatus(fn: (s: RelayStatus) => void): () => void {
  statusListeners.add(fn);
  // Fire once with current state.
  try { fn(snapshotStatus()); } catch { /* ignore */ }
  return () => statusListeners.delete(fn);
}

export function setPinnedNode(url: string | null) { pool.setPinned(url); }
export function addCustomNode(url: string): string | null { return pool.addCustom(url); }
export function removeCustomNode(url: string) { pool.removeCustom(url); }
export async function refreshNodeHealth(): Promise<NodeHealth[]> { return pool.refresh(); }

// Wait until at least one node is reachable (or timeout). Used by callers
// that want to surface a clear "all nodes unreachable" error.
async function waitForNode(timeoutMs = 4000): Promise<BlobNodeClient | null> {
  if (nodeClient) return nodeClient;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (nodeClient) return nodeClient;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Wrap a node operation with failure reporting → triggers failover when the
// active node misbehaves repeatedly.
async function withNode<T>(op: (c: BlobNodeClient) => Promise<T>, fallback: T): Promise<T> {
  const c = await waitForNode();
  if (!c) return fallback;
  const url = activeUrl;
  try {
    const out = await op(c);
    if (url) pool.reportSuccess(url);
    return out;
  } catch (e) {
    if (url) pool.reportFailure(url);
    throw e;
  }
}

// ── BLOCKS ──────────────────────────────────────────────────────────────
// Only fetches the most recent 500 blocks. Balance, supply, addresses, and
// per-address tx history all come from server-side endpoints, so the
// frontend doesn't need full chain history in memory.
const RECENT_BLOCKS = 500;

export async function fetchChain(): Promise<Block[]> {
  return withNode(async (c) => {
    const tip = await c.fetchTip();
    if (!tip || tip.height < 1) return [];
    const from = Math.max(1, tip.height - RECENT_BLOCKS + 1);
    const page = await c.fetchBlocks(from, RECENT_BLOCKS);
    return page as unknown as Block[];
  }, []);
}

// Block sealing is done by the node on its own timer. No-op for compatibility.
export async function sealBlock(_height: number): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}

// Full chain fetch for the explorer — pages from block 1 to tip. Only used
// by callers that explicitly need the entire history (rare; aggregates are
// available server-side).
export async function fetchFullChain(): Promise<Block[]> {
  return withNode(async (c) => {
    const out: Block[] = [];
    let cursor = 1;
    let safety = 10000;
    while (safety-- > 0) {
      const page = await c.fetchBlocks(cursor, 500);
      if (page.length === 0) break;
      out.push(...(page as unknown as Block[]));
      const last = page[page.length - 1].height;
      if (page.length < 500) break;
      cursor = last + 1;
    }
    return out;
  }, []);
}

export async function fetchBalance(address: string): Promise<number> {
  return withNode(async (c) => c.fetchBalance(address), 0);
}

export async function fetchAddressTxs(address: string, limit = 200): Promise<any[]> {
  return withNode(async (c) => c.fetchAddressTxs(address, limit), []);
}

export async function fetchStats(): Promise<{ height: number; totalSupply: number; totalTxs: number }> {
  return withNode(async (c) => {
    const s = await c.fetchStats();
    return s ?? { height: 0, totalSupply: 0, totalTxs: 0 };
  }, { height: 0, totalSupply: 0, totalTxs: 0 });
}

// ── MEMPOOL ─────────────────────────────────────────────────────────────
export async function fetchMempool(): Promise<Tx[]> {
  return withNode(async (c) => {
    const txs = await c.fetchMempool();
    return txs as unknown as Tx[];
  }, []);
}

export async function fetchFeeInfo(): Promise<FeeInfo | null> {
  return withNode(async (c) => c.fetchFeeInfo(), null);
}

export async function pushTx(
  tx: Tx,
): Promise<{ ok: boolean; error?: string; fee?: number; bytes?: number }> {
  const c = await waitForNode();
  if (!c) return { ok: false, error: "All nodes unreachable" };
  try {
    const ack = await c.submitTx({
      id: tx.id,
      nonce: (tx as any).nonce,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      feeRate: tx.feeRate ?? 0,
      memo: tx.memo ?? "",
      signature: tx.signature,
      publicKey: tx.publicKey,
      timestamp: tx.timestamp,
    });
    if (activeUrl) pool.reportSuccess(activeUrl);
    return { ok: true, fee: ack.fee, bytes: ack.bytes };
  } catch (e: any) {
    if (activeUrl) pool.reportFailure(activeUrl);
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ── ENTRIES ─────────────────────────────────────────────────────────────
export async function fetchEntries(blockHeight: number): Promise<Entry[]> {
  return withNode(async (c) => {
    const rows = await c.fetchEntries(blockHeight);
    return rows.map((r: any) => ({
      address: r.address,
      // Commit-only entries have score=null; preserve the distinction so the UI
      // can show "Committed" instead of a zero score.
      score: r.score == null ? 0 : Number(r.score),
      block_height: Number(r.block_height ?? blockHeight),
      block_seed: r.block_seed,
      signature: r.signature,
      pending: !!r.pending,
    }));
  }, []);
}

// Two-phase entry submission (commit-reveal + PoW).
//
// Phase 4 hardening: the network no longer accepts the old single-shot
// `submitEntry`. Submission is now:
//   1. compute commit_hash = sha256(score|inputs_hash|salt) (blinds the score)
//   2. mine ENTRY_POW_BITS of leading-zero PoW on (height, address, commit_hash, nonce)
//      → ~0.5–1.5s on a laptop, ~10x more for sybil rigs across many wallets
//   3. submitEntryCommit during the early part of the block window
//   4. submitEntryReveal during the last ENTRY_REVEAL_WINDOW_SECONDS, exposing
//      the trace + salt — the node re-simulates and accepts the score
//
// Phase 6: single-shot entry submission. The player computes inputs_hash,
// mines PoW over (height, address, inputs_hash), signs the entry payload,
// and sends one submitEntry message containing everything. The node
// validates fully (signature + PoW + simulator + window) and gossips the
// entry to all peers + browsers. No reveal step - if the player closes
// their browser immediately after submission, the entry is fully recorded
// on every node and will be considered for the lottery at seal time.
//
// Snipe protection is purely from the commit-window cutoff: no submissions
// accepted in the last ENTRY_REVEAL_WINDOW_SECONDS of the block window. By
// the time anyone sees a high score on the gossip stream, no new entries
// can be submitted to react to it.
import { signData } from "@/lib/blob/crypto";
import {
  ENTRY_POW_BITS, mineEntryPow,
} from "@/lib/blob/entryPow";

export type EntrySubmission = Entry & {
  publicKey: string;
  privateKey?: string;
  inputs?: string;
  inputs_hash?: string;
  frame_count?: number;
  engine_version?: number;
};

export async function pushEntry(
  e: EntrySubmission,
): Promise<{ ok: boolean; error?: string; phase?: "submit" }> {
  const c = await waitForNode();
  if (!c) return { ok: false, error: "All nodes unreachable" };
  if (!e.privateKey) return { ok: false, error: "missing privateKey for entry signing" };
  if (!e.inputs_hash) return { ok: false, error: "missing inputs_hash" };

  try {
    // Mine PoW (yields to the event loop so the game UI stays responsive).
    // Bound to (height, address, inputs_hash) so the work is tied to this
    // specific play - a different inputs trace would invalidate the nonce.
    const { nonce } = await mineEntryPow(
      e.block_height, e.address, e.inputs_hash, ENTRY_POW_BITS,
    );

    // Sign the entry message exactly as the validator expects.
    const entryPayload = `entry:${e.block_height}:${e.address}:${Math.floor(e.score)}:${e.inputs_hash}`;
    const signature = await signData(e.privateKey, entryPayload);

    await c.submitEntry({
      address: e.address,
      block_height: e.block_height,
      block_seed: String(e.block_seed ?? ""),
      score: e.score,
      frame_count: e.frame_count ?? 0,
      inputs: e.inputs ?? "",
      inputs_hash: e.inputs_hash,
      pow_nonce: nonce,
      publicKey: e.publicKey,
      signature,
      engine_version: e.engine_version ?? 0,
    });

    if (activeUrl) pool.reportSuccess(activeUrl);
    return { ok: true };
  } catch (err: any) {
    if (activeUrl) pool.reportFailure(activeUrl);
    return { ok: false, error: err?.message ?? String(err), phase: "submit" };
  }
}

export async function registerAddress(p: {
  address: string;
  publicKey: string;
  signature: string;
  timestamp: number;
}): Promise<{ ok: boolean; error?: string }> {
  const c = await waitForNode();
  if (!c) return { ok: false, error: "All nodes unreachable" };
  return c.registerAddress(p);
}

// ── ADDRESSES ──────────────────────────────────────────────────────────
export type AddressRecord = {
  address: string;
  publicKey?: string;
  blocksWon?: number;
  totalMined?: number;
  balance?: number;
  bestScore?: number;
  gamesPlayed?: number;
  firstSeen?: string | null;
  lastActive?: string | null;
};

export async function fetchAddresses(): Promise<AddressRecord[]> {
  return withNode(async (c) => {
    const rows = await c.fetchAddresses(2000, 0);
    return rows.map((r: any) => ({
      address: r.address,
      publicKey: r.publicKey ?? undefined,
      blocksWon: Number(r.blocksWon ?? 0),
      totalMined: Number(r.totalMined ?? 0),
      balance: r.balance != null ? Number(r.balance) : undefined,
      bestScore: Number(r.bestScore ?? 0),
      gamesPlayed: Number(r.gamesPlayed ?? 0),
      firstSeen: r.firstSeen ?? null,
      lastActive: r.lastActive ?? null,
    }));
  }, []);
}

// ── BRIDGE (BLOB → Solana SPL) — Supabase only ─────────────────────────
//
// The bridge is custodial (it holds Solana mint authority) so it stays on
// Supabase edge functions regardless of which full node is active.
//
// Flow:
//   1. Frontend checks if recipient has a WBLOB ATA on Solana.
//   2. User clicks "Bridge" → wallet sends a SOL transfer to the mint
//      authority covering ATA rent (if new) + tx fee → sol_signature.
//   3. User signs + broadcasts the BLOB deposit tx.
//   4. registerBridgeRequest() POSTs both to bridge-mint.
//   5. Backend verifies the SOL payment on-chain, then auto-mints WBLOB
//      once the BLOB tx reaches REQUIRED_CONFIRMATIONS.
//   6. After mint, sol_signature is overwritten with the WBLOB mint tx sig.

export type BridgeRequest = {
  blob_tx_id:    string;
  from_address:  string;
  sol_address:   string;
  amount:        number;
  status:        "pending" | "confirmed" | "minting" | "minted" | "failed";
  sol_signature: string | null;
  error:         string | null;
  created_at:    string;
  confirmed_at:  string | null;
  minted_at:     string | null;
  confirmations?: number | null;
};

// Must stay in sync with REQUIRED_CONFIRMATIONS in supabase/functions/bridge-mint/index.ts
export const BRIDGE_REQUIRED_CONFIRMATIONS = 3;

export type BridgeConfig = {
  bridgeAddress:        string;
  splMintAddress:       string | null;
  solanaRpcUrl?:        string | null;
  mintAuthorityPubkey?: string | null;
};

export async function fetchBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    const supaUrl = (import.meta as any).env.VITE_SUPABASE_URL;
    const apiKey  = (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY;
    const headers = { apikey: apiKey };
    // Fetch base config (bridgeAddress, splMintAddress, solanaRpcUrl) and
    // the mint authority pubkey (needed for the SOL fee payment) in parallel.
    const [cfgRes, mintRes] = await Promise.all([
      fetch(`${supaUrl}/functions/v1/bridge-config`, { headers }),
      fetch(`${supaUrl}/functions/v1/bridge-mint/config`, { headers }),
    ]);
    if (!cfgRes.ok) return null;
    const cfg = await cfgRes.json() as BridgeConfig;
    if (mintRes.ok) {
      const mintCfg = await mintRes.json() as { mintAuthorityPubkey?: string | null };
      cfg.mintAuthorityPubkey = mintCfg.mintAuthorityPubkey ?? null;
    }
    return cfg;
  } catch (e) {
    console.error("[relay] fetchBridgeConfig", e);
    return null;
  }
}

// registerBridgeRequest
//
// Call after:
//   1. SOL fee payment sent to mint authority via Phantom → sol_signature
//   2. BLOB deposit tx broadcast to mempool → blob_tx_id
export async function registerBridgeRequest(p: {
  blob_tx_id:    string;
  sol_address:   string;
  amount:        number;
  from_address:  string;
  sol_signature: string;
}): Promise<{ ok: boolean; error?: string; data?: BridgeRequest }> {
  // C3: the bridge verifies the BLOB deposit against the server-configured
  // BLOB_NODE_URL only. The client no longer supplies a node URL.
  const { data, error } = await supabase.functions.invoke("bridge-mint", {
    body: { ...p },
  });
  if (error) return { ok: false, error: error.message };
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true, data: data as BridgeRequest };
}

export async function pollBridgeRequest(blob_tx_id: string): Promise<BridgeRequest | null> {
  try {
    // C3: no client node_url — the bridge polls its own trusted BLOB_NODE_URL.
    const params   = new URLSearchParams({ blob_tx_id });
    const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/bridge-mint?${params.toString()}`;
    const res = await fetch(url, {
      headers: { apikey: (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgeRequest;
  } catch { return null; }
}

export async function fetchBridgeHistory(address?: string): Promise<BridgeRequest[]> {
  let q = supabase
    .from("bridge_requests")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (address) q = q.eq("from_address", address);
  const { data, error } = await q;
  if (error) { console.error("[relay] fetchBridgeHistory", error); return []; }
  return (data ?? []) as BridgeRequest[];
}

// ── REVERSE BRIDGE (WBLOB → BLOB) ──────────────────────────────────────
export type RedeemRequest = {
  sol_signature: string;
  blob_address: string;
  amount: number;
  credit_amount: number | null;
  bridge_fee: number | null;
  status: "pending" | "verified" | "crediting" | "credited" | "failed";
  blob_tx_id: string | null;
  error: string | null;
  created_at: string;
  verified_at: string | null;
  credited_at: string | null;
};

export async function registerRedeem(p: {
  sol_signature: string;
  blob_address: string;
  amount: number;
}): Promise<{ ok: boolean; error?: string; data?: RedeemRequest }> {
  const { data, error } = await supabase.functions.invoke("bridge-redeem", { body: p });
  if (error) return { ok: false, error: error.message };
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true, data: data as RedeemRequest };
}

export async function pollRedeem(sol_signature: string): Promise<RedeemRequest | null> {
  try {
    const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/bridge-redeem?sol_signature=${encodeURIComponent(sol_signature)}`;
    const res = await fetch(url, {
      headers: { apikey: (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()) as RedeemRequest;
  } catch { return null; }
}

export async function fetchRedeemHistory(blob_address?: string): Promise<RedeemRequest[]> {
  let q = supabase
    .from("bridge_redeems")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (blob_address) q = q.eq("blob_address", blob_address);
  const { data, error } = await q;
  if (error) { console.error("[relay] fetchRedeemHistory", error); return []; }
  return (data ?? []) as RedeemRequest[];
}

// ── REALTIME ────────────────────────────────────────────────────────────
export type RelayHandlers = {
  onBlock?: (b: Block) => void;
  onTx?: (t: Tx) => void;
  onTxRemoved?: (id: string) => void;
  onEntry?: (e: Entry) => void;
  onEntryCommit?: (c: import("@/lib/wsProtocol").EntryCommit) => void;
  onActiveEntries?: (
    height: number,
    commits: import("@/lib/wsProtocol").EntryCommit[],
    reveals: Entry[],
  ) => void;
  onTip?: (tip: { height: number; hash: string; totalSupply: number; timestamp: number }) => void;
};

// Subscribes to live updates from whichever full node is currently active.
// On node failover the underlying client is swapped automatically — we
// re-attach handlers each time `nodeClient` changes.
export function subscribeRelay(h: RelayHandlers): () => void {
  let cancelled = false;
  let attachedClient: BlobNodeClient | null = null;
  const liveMempool = new Set<string>();

  function attach(c: BlobNodeClient) {
    attachedClient = c;
    c.setHandlers({
      onBlock: (b) => {
        for (const t of b.transactions ?? []) {
          const id = (t as any)?.id;
          if (id && liveMempool.delete(id)) h.onTxRemoved?.(id);
        }
        h.onBlock?.(b as unknown as Block);
      },
      onTx: (t) => {
        if (t.id) liveMempool.add(t.id);
        h.onTx?.(t as unknown as Tx);
      },
      onEntry: (e) => h.onEntry?.({
        address: e.address,
        score: e.score,
        block_height: e.block_height,
        block_seed: e.block_seed,
        signature: e.signature,
        inputs: e.inputs ?? undefined,
        inputs_hash: e.inputs_hash ?? undefined,
        frame_count: e.frame_count ?? undefined,
        engine_version: e.engine_version,
      }),
      onEntryCommit: (c) => h.onEntryCommit?.(c),
      onActiveEntries: (height, commits, reveals) => h.onActiveEntries?.(height, commits, reveals),
      onTip: (t) => h.onTip?.(t),
    });
    c.connect();
  }

  if (nodeClient) attach(nodeClient);

  // Re-attach if the active node changes mid-session.
  const off = pool.on((e) => {
    if (cancelled) return;
    if (e.type !== "active-changed") return;
    if (attachedClient) {
      try { attachedClient.setHandlers({}); } catch { /* ignore */ }
      attachedClient = null;
    }
    if (nodeClient) attach(nodeClient);
  });

  return () => {
    cancelled = true;
    off();
    if (attachedClient) {
      try { attachedClient.setHandlers({}); } catch { /* ignore */ }
      attachedClient = null;
    }
  };
}