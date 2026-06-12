// Pool relay — Solana-native two-sided CLOB. Both buyers and sellers escrow
// principal + 1% fee in their native asset; matching happens at placement.
const FN_BASE = `${(import.meta as any).env.VITE_SUPABASE_URL}/functions/v1`;
const APIKEY  = (import.meta as any).env.VITE_SUPABASE_PUBLISHABLE_KEY;

export type PoolOrder = {
  id: string;
  side: "buy" | "sell";
  owner_sol_address: string;
  price_usdc: number;
  amount_wblob: number;
  remaining_wblob: number;
  deposit_amount: number;
  remaining_deposit: number;
  fee_amount: number;
  remaining_fee: number;
  status: "pending_deposit" | "open" | "partial" | "filled" | "cancelling" | "cancelled" | "failed";
  deposit_sig: string;
  refund_sig: string | null;
  error: string | null;
  created_at: string;
  cancelled_at: string | null;
};

export type PoolFill = {
  id: string;
  maker_order_id: string;
  taker_order_id: string;
  buyer_sol_address: string;
  seller_sol_address: string;
  price_usdc: number;
  wblob_amount: number;
  usdc_amount: number;
  fee_wblob: number;
  fee_usdc: number;
  release_wblob_sig: string | null;
  release_usdc_sig: string | null;
  status: "pending_release" | "released" | "failed";
  error: string | null;
  created_at: string;
};

export type PoolBook = {
  escrow_address: string | null;
  wblob_mint: string;
  usdc_mint: string;
  treasury: string | null;
  fee_bps: number;
  sol_fee_lamports: string;
  asks: PoolOrder[];
  bids: PoolOrder[];
  fills: PoolFill[];
  mine: PoolOrder[];
  stats: { vol_blob: number; vol_usdc: number; last_price: number | null };
};

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(`${FN_BASE}${path}`, { headers: { apikey: APIKEY } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}
async function postJson<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(`${FN_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: APIKEY },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j?.error || `${path} ${r.status}` };
    return { ok: true, data: j as T };
  } catch (e) { return { ok: false, error: String(e) }; }
}

export async function fetchPoolBook(owner?: string): Promise<PoolBook | null> {
  const q = owner ? `?owner=${encodeURIComponent(owner)}` : "";
  return getJson<PoolBook>(`/pool-orders${q}`);
}
export async function fetchPoolCandles(): Promise<Candle[]> {
  const r = await getJson<{ candles: Candle[] }>(`/pool-orders/candles`);
  return r?.candles ?? [];
}
export async function placePoolOrder(p: {
  side: "buy" | "sell";
  owner_sol_address: string;
  deposit_sig: string;
  price_usdc: number;
  amount_wblob: number;
}) {
  return postJson<PoolOrder>("/pool-orders/place", p);
}
export async function cancelPoolOrder(p: { order_id: string; ts: number; signature_b58: string }) {
  return postJson<PoolOrder>("/pool-orders/cancel", p);
}
