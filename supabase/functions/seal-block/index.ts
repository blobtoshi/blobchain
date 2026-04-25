// Seals a closed block on the server. Re-fetches verified entries from DB,
// re-runs the deterministic weighted-lottery winner selection, and persists
// the block with confirmed transactions. Idempotent on (height) PK.
import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
// deno type-check chokes on the 2.95 generics; cast to any so call sites stay clean.
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";

const BLOCK_TIME = 120;
const INITIAL_REWARD = 10;
const HALVING_BLOCKS = 1_000_000;   // halves every 1M blocks
const MAX_SUPPLY = 20_000_000;       // hard cap: Σ rewards = 10 × 1M × 2 = 20M
const GENESIS_TIME_MS = 1776731760000;
const TX_FEE = 0.001;
const MAX_BLOCK_SIZE = 1_000_000;   // 1 MB, Bitcoin-style
const MAX_TX_SIZE = 100_000;        // 100 KB, Bitcoin standard tx limit
const BLOB_UNIT = 1e8;               // 8-decimal base unit
const to8 = (n: number) => Math.round(Number(n) * BLOB_UNIT) / BLOB_UNIT;

const GENESIS_HASH =
  "genesis00000000000000000000000000000000000000000000000000000000blob";

const enc = new TextEncoder();
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getRewardForHeight(h: number) {
  const halvings = Math.floor(h / HALVING_BLOCKS);
  return Math.min(INITIAL_REWARD / Math.pow(2, halvings), INITIAL_REWARD);
}
function currentHeight() {
  const now = Math.floor(Date.now() / 1000);
  const genesis = Math.floor(GENESIS_TIME_MS / 1000);
  return Math.floor(Math.max(0, now - genesis) / BLOCK_TIME) + 1;
}
function mkPrng(seed: number) {
  let s = (Math.abs(+seed) * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pickWinner(entries: any[], blockSeed: number) {
  if (!entries?.length) return null;
  const sorted = [...entries].sort((a, b) => (a.address < b.address ? -1 : 1));
  const total = sorted.reduce((s, e) => s + Number(e.score || 0), 0);
  if (total === 0) return sorted[0];
  const rng = mkPrng(blockSeed);
  let target = rng() * total;
  for (const e of sorted) {
    target -= Number(e.score || 0);
    if (target <= 0) return e;
  }
  return sorted[sorted.length - 1];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { height } = body ?? {};
    const targetHeight = Number(height);
    if (!Number.isFinite(targetHeight) || targetHeight < 1)
      return bad("invalid height");

    // Self-gating: reject any future height. Past/catch-up heights are still
    // bounded by the "previous block must exist" + "block window must have
    // elapsed" + "must have entries" checks below, so the DB-load surface is
    // bounded by the chain tip — not by client input.
    const wallHeight = currentHeight();
    if (targetHeight > wallHeight) {
      return bad(`block #${targetHeight} not yet open (current #${wallHeight})`);
    }

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Idempotent: already sealed?
    const { data: existing } = await supa
      .from("blob_chain").select("height").eq("height", targetHeight).maybeSingle();
    if (existing) return ok_({ already: true });

    // Sequential progression: a block can only be sealed if its predecessor exists.
    // Combined with the "must have entries" rule below, the chain halts on an unmined block.
    const { data: prev } = await supa
      .from("blob_chain").select("hash,total_supply,height,timestamp")
      .order("height", { ascending: false }).limit(1).maybeSingle();
    const prevHeight = Number(prev?.height ?? 0);
    if (targetHeight !== prevHeight + 1) {
      return bad(`out-of-order seal (expected #${prevHeight + 1}, got #${targetHeight})`);
    }
    const previousHash = prev?.hash ?? GENESIS_HASH;
    const prevSupply = Number(prev?.total_supply ?? 0);

    // Enforce minimum 120s block window since the previous block (or genesis).
    const prevTs = prev?.timestamp ? Number(prev.timestamp) : GENESIS_TIME_MS;
    const elapsedMs = Date.now() - prevTs;
    if (elapsedMs < BLOCK_TIME * 1000) {
      return bad(`block window not elapsed (${Math.ceil((BLOCK_TIME * 1000 - elapsedMs) / 1000)}s remaining)`);
    }

    // Verified entries (only those that passed signature check at write time)
    const { data: entriesRaw } = await supa
      .from("blob_entries").select("address,username,score,signature")
      .eq("block_height", targetHeight);
    const entries = entriesRaw ?? [];

    // PROOF-OF-GAMING: refuse to seal a block with no miners.
    // The block stays open indefinitely until at least one player submits a score.
    if (entries.length === 0) {
      return bad("awaiting miner (no entries submitted)");
    }

    const seedNum = targetHeight * 6364136223846793 + 1442695040888963407;
    const seed = Math.abs(seedNum % 2147483647);
    const winner = pickWinner(entries, seed);

    // PROOF-OF-GAMING: a block with no miner cannot confirm transactions.
    // Mempool txs stay pending and roll over to a future block that has a winner.
    // This makes the gaming layer load-bearing: no players → no settlement.
    let txs: Array<{
      id: string; from: string; fromUsername: string | null; to: string;
      amount: number; fee: number; feeRate: number; memo: string;
      signature: string; publicKey: string; timestamp: number;
    }> = [];
    if (winner) {
      // Pull mempool txs to include. Order by fee_rate DESC (highest priority
      // first) — Bitcoin-style block-template construction.
      const { data: txRows } = await supa
        .from("blob_mempool").select("*")
        .order("fee_rate", { ascending: false })
        .order("timestamp", { ascending: true })
        .limit(5000);
      const allTxs = (txRows ?? []).map((r: any) => ({
        id: r.id,
        from: r.from_address,
        fromUsername: r.from_username,
        to: r.to_address,
        amount: Number(r.amount),
        fee: Number(r.fee ?? 0),
        feeRate: Number(r.fee_rate ?? 10),
        memo: r.memo ?? "",
        signature: r.signature,
        publicKey: r.public_key,
        timestamp: Number(r.timestamp),
      }));
      // Reserve ~10 KB of header/coinbase overhead, then greedily pack txs
      const HEADER_OVERHEAD = 10_000;
      let used = HEADER_OVERHEAD;
      for (const t of allTxs) {
        const sz = JSON.stringify(t).length;
        if (sz > MAX_TX_SIZE) continue; // drop oversize tx
        if (used + sz > MAX_BLOCK_SIZE) break;
        txs.push(t);
        used += sz;
      }
    }

    const baseReward = getRewardForHeight(targetHeight);
    const feeTotal = txs.reduce((s, t) => s + (Number(t.fee) || 0), 0);
    // Hard supply cap: clamp the coinbase portion so total_supply never exceeds MAX_SUPPLY.
    // Fees are recycled value (not new issuance), so they're always paid to the winner.
    const remainingIssuance = Math.max(0, MAX_SUPPLY - prevSupply);
    const coinbase = winner ? Math.min(baseReward, remainingIssuance) : 0;
    const reward = winner ? to8(coinbase + feeTotal) : 0;
    const newSupply = to8(prevSupply + coinbase);

    const block = {
      height: targetHeight,
      previous_hash: previousHash,
      timestamp: Date.now(),
      transactions: JSON.stringify(txs),
      mining_entries: JSON.stringify(entries),
      winner: winner?.address ?? null,
      winner_username: winner?.username ?? null,
      winner_score: Number(winner?.score ?? 0),
      reward,
      seed: String(targetHeight),
      node_count: 1,
      total_supply: newSupply,
      hash: "",
    };
    block.hash = await sha256hex([
      block.height, block.previous_hash, block.timestamp,
      block.winner ?? "null", block.winner_score, block.reward, block.seed,
      txs.length,
    ].join("|"));

    const { error } = await supa.from("blob_chain").insert(block);
    if (error) {
      // 23505 = duplicate height (raced with another sealer) — treat as success
      if ((error as any).code !== "23505") {
        console.error("[seal-block] insert failed", error);
        return bad("internal error", 500);
      }
    }

    // Clear included mempool txs
    if (txs.length) {
      await supa.from("blob_mempool").delete().in("id", txs.map(t => t.id));
    }

    return ok_({ height: targetHeight, winner: block.winner, reward });
  } catch (e) {
    console.error("[seal-block] unexpected error", e);
    return bad("internal error", 500);
  }
});

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function ok_(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
