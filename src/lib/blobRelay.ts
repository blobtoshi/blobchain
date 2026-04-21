// Blob Chain P2P relay backed by Lovable Cloud (Supabase).
// Reads are direct (RLS allows public SELECT); all writes go through
// signature-verifying edge functions (entries, transactions, block sealing).

import { supabase } from "@/integrations/supabase/client";

export type Block = {
  height: number;
  previousHash: string;
  timestamp: number;
  transactions: any[];
  miningEntries: any[];
  winner: string | null;
  winnerUsername?: string | null;
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
  fromUsername?: string;
  to: string;
  amount: number;
  fee?: number;
  signature: string;
  publicKey: string;
  timestamp: number;
};

export type Entry = {
  address: string;
  username?: string;
  score: number;
  block_height: number;
  block_seed?: string;
  signature: string;
};

const safeParse = (s: any, fallback: any) => {
  try { return typeof s === "string" ? JSON.parse(s) : (s ?? fallback); }
  catch { return fallback; }
};

// ── BLOCKS ──────────────────────────────────────────────────────────────
function blockFromRow(r: any): Block {
  return {
    height: Number(r.height),
    previousHash: r.previous_hash,
    timestamp: Number(r.timestamp),
    transactions: safeParse(r.transactions, []),
    miningEntries: safeParse(r.mining_entries, []),
    winner: r.winner,
    winnerUsername: r.winner_username,
    winnerScore: r.winner_score ?? 0,
    reward: Number(r.reward ?? 0),
    seed: String(r.seed ?? ""),
    hash: r.hash,
    totalSupply: Number(r.total_supply ?? 0),
    nodeCount: r.node_count ?? 1,
  };
}

export async function fetchChain(): Promise<Block[]> {
  const { data, error } = await supabase
    .from("blob_chain").select("*").order("height", { ascending: true });
  if (error) { console.error("[relay] fetchChain", error); return []; }
  return (data ?? []).map(blockFromRow);
}

// Block sealing happens on the server; trigger it for a closed height.
// Idempotent: server returns { already: true } if already sealed.
export async function sealBlock(height: number): Promise<{ ok: boolean; error?: string }> {
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
    fromUsername: r.from_username,
    to: r.to_address,
    amount: Number(r.amount),
    fee: Number(r.fee ?? 0.001),
    signature: r.signature,
    publicKey: r.public_key,
    timestamp: Number(r.timestamp),
  };
}

export async function fetchMempool(): Promise<Tx[]> {
  const { data, error } = await supabase
    .from("blob_mempool").select("*").order("timestamp", { ascending: true });
  if (error) { console.error("[relay] fetchMempool", error); return []; }
  return (data ?? []).map(txFromRow);
}

export async function pushTx(tx: Tx): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("submit-tx", {
    body: {
      id: tx.id,
      from: tx.from,
      fromUsername: tx.fromUsername,
      to: tx.to,
      amount: tx.amount,
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
  return { ok: true };
}

// ── ENTRIES ─────────────────────────────────────────────────────────────
function entryFromRow(r: any): Entry {
  return {
    address: r.address,
    username: r.username,
    score: Number(r.score ?? 0),
    block_height: Number(r.block_height),
    block_seed: r.block_seed,
    signature: r.signature,
  };
}

export async function fetchEntries(blockHeight: number): Promise<Entry[]> {
  const { data, error } = await supabase
    .from("blob_entries").select("*").eq("block_height", blockHeight);
  if (error) { console.error("[relay] fetchEntries", error); return []; }
  return (data ?? []).map(entryFromRow);
}

export async function pushEntry(
  e: Entry & { publicKey: string }
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.functions.invoke("submit-entry", {
    body: {
      address: e.address,
      username: e.username,
      score: e.score,
      block_height: e.block_height,
      block_seed: e.block_seed,
      signature: e.signature,
      publicKey: e.publicKey,
    },
  });
  if (error) {
    console.error("[relay] pushEntry", error);
    return { ok: false, error: error.message };
  }
  if ((data as any)?.error) return { ok: false, error: (data as any).error };
  return { ok: true };
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
