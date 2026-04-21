// Verifies a secp256k1 (Bitcoin curve) signed transaction and inserts into the mempool.
// Server-side balance check from confirmed chain + pending mempool spend.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2.95.0/cors";
import * as secp from "npm:@noble/secp256k1@2.1.0";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "npm:@noble/hashes@1.5.0/ripemd160";
import { base58check } from "npm:@scure/base@1.1.9";

const TX_FEE = 0.001;
const MAX_TX_SIZE = 100_000; // 100 KB, Bitcoin standard tx limit
const BLOB_UNIT = 1e8;        // $BLOB is divisible to 8 decimals
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

async function calcBalance(supa: ReturnType<typeof createClient>, address: string) {
  const { data: chain } = await supa
    .from("blob_chain").select("winner,reward,transactions").order("height", { ascending: true });
  let bal = 0;
  for (const b of chain ?? []) {
    if (b.winner === address) bal += Number(b.reward ?? 0);
    const txs = safeParse(b.transactions, []) as any[];
    for (const tx of txs) {
      if (tx.to === address) bal += Number(tx.amount);
      if (tx.from === address) bal -= Number(tx.amount) + Number(tx.fee ?? TX_FEE);
    }
  }
  const { data: pend } = await supa
    .from("blob_mempool").select("amount,fee,from_address").eq("from_address", address);
  for (const p of pend ?? []) bal -= Number(p.amount) + Number(p.fee ?? TX_FEE);
  return Math.max(0, bal);
}

const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;
const ID_RE = /^[0-9a-fA-F]{8,64}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const raw = await req.text();
    if (raw.length > MAX_TX_SIZE) return bad(`tx too large (max ${MAX_TX_SIZE} bytes)`);
    const body = JSON.parse(raw);
    const { id, from, fromUsername, to, amount, signature, publicKey, timestamp } = body ?? {};

    if (typeof id !== "string" || !ID_RE.test(id)) return bad("invalid id");
    if (typeof from !== "string" || !ADDR_RE.test(from)) return bad("invalid from");
    if (typeof to !== "string" || !ADDR_RE.test(to)) return bad("invalid to");
    if (from === to) return bad("self-send not allowed");
    if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return bad("invalid publicKey");
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return bad("invalid signature");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return bad("invalid amount");
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return bad("invalid timestamp");
    if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return bad("timestamp out of window");

    const derived = pubKeyToAddress(publicKey.toLowerCase());
    if (derived !== from) return bad("from does not match publicKey");

    const payload = `${from}→${to}:${amt}@${ts}`;
    if (!verifySig(publicKey, signature, payload)) return bad("bad signature");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const bal = await calcBalance(supa, from);
    if (amt + TX_FEE > bal) return bad(`insufficient balance (need ${(amt + TX_FEE).toFixed(6)})`);

    const { error } = await supa.from("blob_mempool").insert({
      id,
      from_address: from,
      from_username: fromUsername?.toString().slice(0, 24) ?? null,
      to_address: to,
      amount: amt,
      fee: TX_FEE,
      signature,
      public_key: publicKey,
      timestamp: ts,
      status: "pending",
    });
    if (error && (error as any).code !== "23505") return bad(error.message, 500);

    return ok_({ id });
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
