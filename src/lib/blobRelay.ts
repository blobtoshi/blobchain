// Blob Chain P2P relay.
//
// Two backends, selected by VITE_BLOB_RELAY_MODE ∈ {"node","supabase","auto"}:
//   • supabase — original path: direct table reads + edge functions for writes.
//   • node     — connect to a BLOB CHAIN full node (REST + WebSocket /ws).
//   • auto     — probe VITE_BLOB_NODE_URL/health at boot; node if healthy, else supabase.
//
// All public exports keep the same signatures so callers (useBlockchain,
// SendTxForm, MiningPanel, etc.) don't need to change. Bridge + address
// registry + redeem flows remain on Supabase regardless of mode — they're
// orthogonal to chain consensus.

import { supabase } from "@/integrations/supabase/client";
import { BlobNodeClient } from "@/lib/blobNodeClient";

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
  // Anti-cheat replay fields (optional for backward-compat reads)
  inputs?: string;
  inputs_hash?: string;
  frame_count?: number;
  engine_version?: number;
};

const safeParse = (s: any, fallback: any) => {
  try { return typeof s === "string" ? JSON.parse(s) : (s ?? fallback); }
  catch { return fallback; }
};

// ── Mode + node singleton ───────────────────────────────────────────────
export type RelayMode = "node" | "supabase";

const env = (import.meta as any).env ?? {};
const NODE_URL: string | undefined = env.VITE_BLOB_NODE_URL || undefined;
const RELAY_MODE_RAW: string = String(env.VITE_BLOB_RELAY_MODE ?? "auto").toLowerCase();

let activeMode: RelayMode = "supabase";
let nodeClient: BlobNodeClient | null = null;
let modeReady: Promise<RelayMode> | null = null;
const modeListeners = new Set<(m: RelayMode) => void>();

function emitMode() {
  for (const l of modeListeners) { try { l(activeMode); } catch { /* ignore */ } }
}

export function onRelayModeChange(fn: (m: RelayMode) => void) {
  modeListeners.add(fn);
  try { fn(activeMode); } catch { /* ignore */ }
  return () => modeListeners.delete(fn);
}

export function getRelayMode(): RelayMode { return activeMode; }
export function getNodeClient(): BlobNodeClient | null { return nodeClient; }

async function initRelayMode(): Promise<RelayMode> {
  if (RELAY_MODE_RAW === "supabase" || !NODE_URL) {
    activeMode = "supabase";
    return activeMode;
  }
  if (RELAY_MODE_RAW === "node") {
    nodeClient = new BlobNodeClient(NODE_URL);
    activeMode = "node";
    return activeMode;
  }
  // auto: probe /health.
  const healthy = await BlobNodeClient.healthcheck(NODE_URL);
  if (healthy) {
    nodeClient = new BlobNodeClient(NODE_URL);
    activeMode = "node";
  } else {
    activeMode = "supabase";
  }
  emitMode();
  return activeMode;
}

export function ensureRelayMode(): Promise<RelayMode> {
  if (!modeReady) modeReady = initRelayMode();
  return modeReady;
}

// Kick off the probe immediately so the first call to fetchChain isn't
// slowed down by it (the promise is cached).
ensureRelayMode();

// ── BLOCKS ──────────────────────────────────────────────────────────────
function blockFromRow(r: any): Block {
  return {
    height: Number(r.height),
    previousHash: r.previous_hash,
    timestamp: Number(r.timestamp),
    transactions: safeParse(r.transactions, []),
    miningEntries: safeParse(r.mining_entries, []),
    winner: r.winner,
    winnerScore: r.winner_score ?? 0,
    reward: Number(r.reward ?? 0),
    seed: String(r.seed ?? ""),
    hash: r.hash,
    totalSupply: Number(r.total_supply ?? 0),
    nodeCount: r.node_count ?? 1,
  };
}

export async function fetchChain(): Promise<Block[]> {
  await ensureRelayMode();
  if (activeMode === "node" && nodeClient) {
    // Page through /blocks until we hit an empty/short page.
    const out: Block[] = [];
    let cursor = 1;
    let safety = 1000;
    while (safety-- > 0) {
      const page = await nodeClient.fetchBlocks(cursor, 200);
      if (page.length === 0) break;
      out.push(...page);
      const last = page[page.length - 1].height;
      if (page.length < 200) break;
      cursor = last + 1;
    }
    return out;
  }
  const { data, error } = await supabase
    .from("blob_chain").select("*").order("height", { ascending: true });
  if (error) { console.error("[relay] fetchChain", error); return []; }
  return (data ?? []).map(blockFromRow);
}

// Block sealing happens on the server; trigger it for a closed height.
// In node mode this is a no-op — the node seals on its own timer.
export async function sealBlock(height: number): Promise<{ ok: boolean; error?: string }> {
  await ensureRelayMode();
  if (activeMode === "node") return { ok: true };
  const { data, error } = await supabase.functions.invoke("seal-block", {
    body: { height },
  });
  if (error) {
    console.error("[relay] sealBlock", error);
    return { ok: false, error: error.message };
  }
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true };
}

// ── MEMPOOL ─────────────────────────────────────────────────────────────
function txFromRow(r: any): Tx {
  return {
    id: r.id,
    from: r.from_address,
    to: r.to_address,
    amount: Number(r.amount),
    fee: Number(r.fee ?? 0),
    feeRate: r.fee_rate != null ? Number(r.fee_rate) : undefined,
    memo: r.memo ?? "",
    signature: r.signature,
    publicKey: r.public_key,
    timestamp: Number(r.timestamp),
  };
}

export async function fetchMempool(): Promise<Tx[]> {
  await ensureRelayMode();
  if (activeMode === "node" && nodeClient) {
    return await nodeClient.fetchMempool();
  }
  const { data, error } = await supabase
    .from("blob_mempool").select("*").order("timestamp", { ascending: true });
  if (error) { console.error("[relay] fetchMempool", error); return []; }
  return (data ?? []).map(txFromRow);
}

export async function fetchFeeInfo(): Promise<FeeInfo | null> {
  await ensureRelayMode();
  if (activeMode === "node" && nodeClient) {
    return await nodeClient.fetchFeeInfo();
  }
  try {
    const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/submit-tx`;
    const res = await fetch(url, {
      headers: { apikey: (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    return (await res.json()) as FeeInfo;
  } catch (e) {
    console.error("[relay] fetchFeeInfo", e);
    return null;
  }
}

export async function pushTx(tx: Tx): Promise<{ ok: boolean; error?: string; fee?: number; bytes?: number }> {
  await ensureRelayMode();
  if (activeMode === "node" && nodeClient) {
    try {
      const ack = await nodeClient.submitTx({
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
      return { ok: true, fee: ack.fee, bytes: ack.bytes };
    } catch (e: any) {
      console.error("[relay] pushTx (node)", e);
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
  const { data, error } = await supabase.functions.invoke("submit-tx", {
    body: {
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      feeRate: tx.feeRate,
      memo: tx.memo ?? "",
      signature: tx.signature,
      publicKey: tx.publicKey,
      timestamp: tx.timestamp,
    },
  });
  if (error) {
    console.error("[relay] pushTx", error);
    return { ok: false, error: error.message };
  }
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true, fee: (data as any)?.fee, bytes: (data as any)?.bytes };
}

// ── ENTRIES ─────────────────────────────────────────────────────────────
function entryFromRow(r: any): Entry {
  return {
    address: r.address,
    score: Number(r.score ?? 0),
    block_height: Number(r.block_height),
    block_seed: r.block_seed,
    signature: r.signature,
  };
}

export async function fetchEntries(blockHeight: number): Promise<Entry[]> {
  await ensureRelayMode();
  // The node doesn't expose a per-height entries REST endpoint; live entries
  // arrive via WS `newEntry` gossip after subscribe. Returning [] here is
  // safe — subscribeRelay will populate state as entries come in.
  if (activeMode === "node") return [];
  const { data, error } = await supabase
    .from("blob_entries").select("*").eq("block_height", blockHeight);
  if (error) { console.error("[relay] fetchEntries", error); return []; }
  return (data ?? []).map(entryFromRow);
}

export async function pushEntry(
  e: Entry & { publicKey: string }
): Promise<{ ok: boolean; error?: string }> {
  await ensureRelayMode();
  if (activeMode === "node" && nodeClient) {
    try {
      await nodeClient.submitEntry({
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
      return { ok: true };
    } catch (err: any) {
      console.error("[relay] pushEntry (node)", err);
      return { ok: false, error: err?.message ?? String(err) };
    }
  }
  const { data, error } = await supabase.functions.invoke("submit-entry", {
    body: {
      address: e.address,
      score: e.score,
      block_height: e.block_height,
      block_seed: e.block_seed,
      signature: e.signature,
      publicKey: e.publicKey,
      inputs: e.inputs ?? "",
      inputs_hash: e.inputs_hash,
      frame_count: e.frame_count,
      engine_version: e.engine_version,
    },
  });
  if (error) {
    console.error("[relay] pushEntry", error);
    return { ok: false, error: error.message };
  }
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true };
}

// Register a wallet in the address registry so it shows up in the
// explorer immediately, even before the user mines or transacts.
export async function registerAddress(p: {
  address: string;
  publicKey: string;
  signature: string;
  timestamp: number;
}): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("register-address", { body: p });
  if (error) {
    console.error("[relay] registerAddress", error);
    return { ok: false, error: error.message };
  }
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true };
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
  const { data, error } = await (supabase as any)
    .from("blob_addresses_public")
    .select("address,blocks_won,total_mined,best_score,games_played,first_seen,last_active")
    .order("first_seen", { ascending: true });
  if (error) { console.error("[relay] fetchAddresses", error); return []; }
  return (data ?? []).map((r: any) => ({
    address: r.address,
    publicKey: undefined,
    blocksWon: Number(r.blocks_won ?? 0),
    totalMined: Number(r.total_mined ?? 0),
    bestScore: Number(r.best_score ?? 0),
    gamesPlayed: Number(r.games_played ?? 0),
    firstSeen: r.first_seen ?? null,
    lastActive: r.last_active ?? null,
  }));
}

// ── BRIDGE (Solana) ────────────────────────────────────────────────────
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
  const { data, error } = await supabase.functions.invoke("bridge-mint", { body: p });
  if (error) return { ok: false, error: error.message };
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true, data: data as BridgeRequest };
}

export async function pollBridgeRequest(blob_tx_id: string): Promise<BridgeRequest | null> {
  try {
    const url = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1/bridge-mint?blob_tx_id=${encodeURIComponent(blob_tx_id)}`;
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

export function subscribeRelay(h: RelayHandlers) {
  const ch = supabase
    .channel("blob-chain-relay")
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "blob_chain" },
      (p) => h.onBlock?.(blockFromRow(p.new)))
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "blob_mempool" },
      (p) => h.onTx?.(txFromRow(p.new)))
    .on("postgres_changes",
      { event: "DELETE", schema: "public", table: "blob_mempool" },
      (p) => { const id = (p.old as any)?.id; if (id) h.onTxRemoved?.(id); })
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "blob_entries" },
      (p) => h.onEntry?.(entryFromRow(p.new)))
    .on("postgres_changes",
      { event: "UPDATE", schema: "public", table: "blob_entries" },
      (p) => h.onEntry?.(entryFromRow(p.new)))
    .subscribe();
  return () => { supabase.removeChannel(ch); };
}
