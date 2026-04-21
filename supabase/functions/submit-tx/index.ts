// Verifies a secp256k1 (Bitcoin curve) signed transaction and inserts into the mempool.
// Bitcoin-style fee model: fee = ceil(feeRate × tx_byte_size) / 1e8 $BLOB.
// feeRate is drops/byte (1 drop = 1e-8 $BLOB, the smallest unit). Server enforces
// a minimum feeRate derived from current mempool congestion.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2.95.0/cors";
import * as secp from "npm:@noble/secp256k1@2.1.0";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "npm:@noble/hashes@1.5.0/ripemd160";
import { base58check } from "npm:@scure/base@1.1.9";

const MAX_TX_SIZE = 100_000;     // 100 KB, Bitcoin standard tx limit
const MAX_BLOCK_SIZE = 1_000_000; // 1 MB
const BLOB_UNIT = 1e8;            // $BLOB is divisible to 8 decimals
const BASE_FEE_RATE = 10;         // drops/byte at zero congestion
const MIN_FEE_RATE = 1;           // absolute floor
const MAX_FEE_RATE = 10_000;      // sanity cap
const MAX_MEMO_BYTES = 80;        // OP_RETURN-style limit
const enc = new TextEncoder();
const b58check = base58check(sha256);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function pubKeyToAddress(pubHex: string) {
  const pub = hexToBytes(pubHex);
  const h160 = ripemd160(sha256(pub));
  const payload = new Uint8Array(1 + 20);
  payload[0] = 0x00;
  payload.set(h160, 1);
  return b58check.encode(payload);
}
function verifySig(pubHex: string, sigHex: string, data: string): boolean {
  try {
    const msgHash = sha256(enc.encode(data));
    return secp.verify(hexToBytes(sigHex), msgHash, hexToBytes(pubHex));
  } catch { return false; }
}

const safeParse = (s: unknown, fb: unknown) => {
  try { return typeof s === "string" ? JSON.parse(s) : (s ?? fb); } catch { return fb; }
};

// Canonical bytes used for fee calculation. Both client and server must
// compute this the same way for a tx to be accepted.
function canonicalTxBytes(tx: {
  from: string; to: string; amount: number; timestamp: number;
  feeRate: number; memo: string; publicKey: string; signature: string;
}): number {
  const canonical = JSON.stringify({
    from: tx.from, to: tx.to, amount: tx.amount, timestamp: tx.timestamp,
    feeRate: tx.feeRate, memo: tx.memo, publicKey: tx.publicKey, signature: tx.signature,
  });
  return enc.encode(canonical).length;
}

function feeFromRate(feeRate: number, bytes: number): number {
  // drop-precise: ceil so the network is never under-paid.
  const drops = Math.ceil(feeRate * bytes);
  return drops / BLOB_UNIT;
}

async function pendingBytes(supa: ReturnType<typeof createClient>) {
  // Approximate mempool weight from row count × average tx size.
  // Cheap and good enough for a congestion signal.
  const { count } = await supa
    .from("blob_mempool").select("id", { count: "exact", head: true });
  // Assume ~600 bytes/tx average — a transfer with memo+sig+pubkey is ~500-700B.
  return (count ?? 0) * 600;
}

async function recommendedFeeRate(supa: ReturnType<typeof createClient>) {
  const bytes = await pendingBytes(supa);
  const load = Math.min(bytes / MAX_BLOCK_SIZE, 10);
  const rec = Math.ceil(BASE_FEE_RATE * Math.pow(1 + load, 2));
  return Math.max(MIN_FEE_RATE, Math.min(rec, MAX_FEE_RATE));
}

async function calcBalance(supa: ReturnType<typeof createClient>, address: string) {
  const { data: chain } = await supa
    .from("blob_chain").select("winner,reward,transactions").order("height", { ascending: true });
  let bal = 0;
  for (const b of chain ?? []) {
    if (b.winner === address) bal += Number(b.reward ?? 0);
    const txs = safeParse(b.transactions, []) as any[];
    for (const tx of txs) {
      if (tx.to === address) bal += Number(tx.amount);
      if (tx.from === address) bal -= Number(tx.amount) + Number(tx.fee ?? 0);
    }
  }
  const { data: pend } = await supa
    .from("blob_mempool").select("amount,fee,from_address").eq("from_address", address);
  for (const p of pend ?? []) bal -= Number(p.amount) + Number(p.fee ?? 0);
  return Math.max(0, bal);
}

const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;
const ID_RE = /^[0-9a-fA-F]{8,64}$/;
// Printable ASCII + common whitespace. Reject control chars to keep memos display-safe.
const MEMO_RE = /^[\x20-\x7E\u00A0-\uFFFF\n\t]*$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // GET /fee-info → recommended feeRate (no auth required, for the Send UI)
  if (req.method === "GET") {
    try {
      const supa = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const rec = await recommendedFeeRate(supa);
      return ok_({
        recommendedFeeRate: rec,
        minFeeRate: MIN_FEE_RATE,
        baseFeeRate: BASE_FEE_RATE,
      });
    } catch (e) {
      return bad(String((e as Error)?.message ?? e), 500);
    }
  }

  try {
    const raw = await req.text();
    if (raw.length > MAX_TX_SIZE) return bad(`tx too large (max ${MAX_TX_SIZE} bytes)`);
    const body = JSON.parse(raw);
    const {
      id, from, fromUsername, to, amount, signature, publicKey, timestamp,
      feeRate: feeRateRaw, memo: memoRaw,
    } = body ?? {};

    if (typeof id !== "string" || !ID_RE.test(id)) return bad("invalid id");
    if (typeof from !== "string" || !ADDR_RE.test(from)) return bad("invalid from");
    if (typeof to !== "string" || !ADDR_RE.test(to)) return bad("invalid to");
    if (from === to) return bad("self-send not allowed");
    if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return bad("invalid publicKey");
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return bad("invalid signature");

    const amtRaw = Number(amount);
    if (!Number.isFinite(amtRaw) || amtRaw <= 0 || amtRaw > 1_000_000) return bad("invalid amount");
    const units = Math.round(amtRaw * BLOB_UNIT);
    if (Math.abs(amtRaw * BLOB_UNIT - units) > 1e-6) return bad("amount exceeds 8-decimal precision");
    const amt = units / BLOB_UNIT;

    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return bad("invalid timestamp");
    if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return bad("timestamp out of window");

    const memo = typeof memoRaw === "string" ? memoRaw : "";
    if (memo.length > 0 && !MEMO_RE.test(memo)) return bad("memo contains invalid characters");
    if (enc.encode(memo).length > MAX_MEMO_BYTES) return bad(`memo exceeds ${MAX_MEMO_BYTES} bytes`);

    const feeRate = Math.floor(Number(feeRateRaw));
    if (!Number.isFinite(feeRate) || feeRate < MIN_FEE_RATE || feeRate > MAX_FEE_RATE) {
      return bad(`invalid feeRate (must be ${MIN_FEE_RATE}–${MAX_FEE_RATE} drops/byte)`);
    }

    const derived = pubKeyToAddress(publicKey.toLowerCase());
    if (derived !== from) return bad("from does not match publicKey");

    // Sign payload v2: includes feeRate + memo so they cannot be tampered with.
    const payload = `${from}→${to}:${amt}@${ts}|fr=${feeRate}|m=${memo}`;
    if (!verifySig(publicKey, signature, payload)) return bad("bad signature");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Enforce minimum feeRate based on current congestion. Allow the
    // sender to underpay relative to "recommended" but never below the
    // congestion-derived floor (which itself never drops below MIN_FEE_RATE).
    // We use 50% of the recommended rate as the acceptance floor — same as
    // a Bitcoin node's `minrelaytxfee` heuristic.
    const recRate = await recommendedFeeRate(supa);
    const floorRate = Math.max(MIN_FEE_RATE, Math.floor(recRate * 0.5));
    if (feeRate < floorRate) {
      return bad(`feeRate too low (network minimum ${floorRate} drops/byte, recommended ${recRate})`);
    }

    const bytes = canonicalTxBytes({
      from, to, amount: amt, timestamp: ts, feeRate, memo, publicKey, signature,
    });
    if (bytes > MAX_TX_SIZE) return bad(`tx too large (max ${MAX_TX_SIZE} bytes)`);
    const fee = feeFromRate(feeRate, bytes);

    const bal = await calcBalance(supa, from);
    if (amt + fee > bal) return bad(`insufficient balance (need ${(amt + fee).toFixed(8)})`);

    const { error } = await supa.from("blob_mempool").insert({
      id,
      from_address: from,
      from_username: fromUsername?.toString().slice(0, 24) ?? null,
      to_address: to,
      amount: amt,
      fee,
      fee_rate: feeRate,
      memo: memo || null,
      signature,
      public_key: publicKey,
      timestamp: ts,
      status: "pending",
    });
    if (error && (error as any).code !== "23505") return bad(error.message, 500);

    return ok_({ id, fee, feeRate, bytes });
  } catch (e) {
    return bad(String((e as Error)?.message ?? e), 500);
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
