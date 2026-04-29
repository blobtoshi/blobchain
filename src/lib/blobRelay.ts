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
  block_seed?: string;
  signature: string;
  inputs?: string;
  inputs_hash?: string;
  frame_count?: number;
  engine_version?: number;
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
};

const statusListeners = new Set<(s: RelayStatus) => void>();
function emitStatus() {
  const s: RelayStatus = {
    activeUrl,
    health: pool.getHealth(),
    pinned: pool.getPinned(),
    custom: pool.getCustom(),
  };
  for (const l of statusListeners) { try { l(s); } catch { /* ignore */ } }
}
pool.on(() => emitStatus());

export function onRelayStatus(fn: (s: RelayStatus) => void): () => void {
  statusListeners.add(fn);
  // Fire once with current state.
  try {
    fn({
      activeUrl,
      health: pool.getHealth(),
      pinned: pool.getPinned(),
      custom: pool.getCustom(),
    });
  } catch { /* ignore */ }
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
export async function fetchChain(): Promise<Block[]> {
  return withNode(async (c) => {
    const out: Block[] = [];
    let cursor = 1;
    let safety = 1000;
    while (safety-- > 0) {
      const page = await c.fetchBlocks(cursor, 200);
      if (page.length === 0) break;
      out.push(...(page as unknown as Block[]));
      const last = page[page.length - 1].height;
      if (page.length < 200) break;
      cursor = last + 1;
    }
    return out;
  }, []);
}

// Block sealing is done by the node on its own timer. No-op for compatibility.
export async function sealBlock(_height: number): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
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
      score: Number(r.score ?? 0),
      block_height: Number(r.block_height ?? blockHeight),
      block_seed: r.block_seed,
      signature: r.signature,
    }));
  }, []);
}

export async function pushEntry(
  e: Entry & { publicKey: string },
): Promise<{ ok: boolean; error?: string }> {
  const c = await waitForNode();
  if (!c) return { ok: false, error: "All nodes unreachable" };
  try {
    await c.submitEntry({
      address: e.address,
      score: e.score,
      block_height: e.block_height,
      block_seed: e.block_seed ?? "",
      signature: e.signature,
      publicKey: e.publicKey,
      inputs: e.inputs ?? "",
      inputs_hash: e.inputs_hash ?? "",
      frame_count: e.frame_count ?? 0,
      engine_version: e.engine_version ?? 0,
    });
    if (activeUrl) pool.reportSuccess(activeUrl);
    return { ok: true };
  } catch (err: any) {
    if (activeUrl) pool.reportFailure(activeUrl);
    return { ok: false, error: err?.message ?? String(err) };
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
  bestScore?: number;
  gamesPlayed?: number;
  firstSeen?: string | null;
  lastActive?: string | null;
};

export async function fetchAddresses(): Promise<AddressRecord[]> {
  return withNode(async (c) => {
    const rows = await c.fetchAddresses(500, 0);
    return rows.map((r: any) => ({
      address: r.address,
      publicKey: r.publicKey ?? undefined,
      blocksWon: Number(r.blocksWon ?? 0),
      totalMined: Number(r.totalMined ?? 0),
      bestScore: Number(r.bestScore ?? 0),
      gamesPlayed: Number(r.gamesPlayed ?? 0),
      firstSeen: r.firstSeen ?? null,
      lastActive: r.lastActive ?? null,
    }));
  }, []);
}

// ── BRIDGE (Solana) — Supabase only ────────────────────────────────────
//
// The bridge is custodial (it holds Solana mint authority) so it can't be
// decentralised — it stays on Supabase edge functions regardless of node.
export type BridgeRequest = {
  blob_tx_id: string;
  from_address: string;
  sol_address: string;
  amount: number;
  status: "pending" | "confirmed" | "minting" | "minted" | "failed";
  sol_signature: string | null;
  error: string | null;
  created_at: string;
  confirmed_at: string | null;
  minted_at: string | null;
};

export type BridgeConfig = {
  bridgeAddress: string;
  splMintAddress: string | null;
  solanaRpcUrl?: string | null;
};

export async function fetchBridgeConfig(): Promise<BridgeConfig | null> {
  try {
    const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/bridge-config`;
    const res = await fetch(url, {
      headers: { apikey: (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgeConfig;
  } catch (e) {
    console.error("[relay] fetchBridgeConfig", e);
    return null;
  }
}

export async function registerBridgeRequest(p: {
  blob_tx_id: string;
  sol_address: string;
  amount: number;
  from_address: string;
}): Promise<{ ok: boolean; error?: string; data?: BridgeRequest }> {
  const node_url = getNodePool().getActive();
  if (!node_url) return { ok: false, error: "no active node — connect to a node first" };
  const { data, error } = await supabase.functions.invoke("bridge-mint", {
    body: { ...p, node_url },
  });
  if (error) return { ok: false, error: error.message };
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true, data: data as BridgeRequest };
}

export async function pollBridgeRequest(blob_tx_id: string): Promise<BridgeRequest | null> {
  try {
    const node_url = getNodePool().getActive();
    const params = new URLSearchParams({ blob_tx_id });
    if (node_url) params.set("node_url", node_url);
    const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/bridge-mint?${params.toString()}`;
    const res = await fetch(url, {
      headers: { apikey: (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()) as BridgeRequest;
  } catch { return null; }
}

export async function fetchBridgeHistory(address?: string): Promise<BridgeRequest[]> {
  let q = supabase.from("bridge_requests").select("*").order("created_at", { ascending: false }).limit(50);
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
  let q = supabase.from("bridge_redeems").select("*").order("created_at", { ascending: false }).limit(50);
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
