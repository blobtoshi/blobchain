// Verifies an ECDSA P-256 signed transaction and inserts into the mempool.
// Server-side balance check from confirmed chain + pending mempool spend.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2.95.0/cors";

const TX_FEE = 0.001;
const enc = new TextEncoder();

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function verifyEcdsa(publicKeyJwk: string, signatureHex: string, data: string) {
  const jwk = JSON.parse(publicKeyJwk);
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key, hexToBytes(signatureHex), enc.encode(data),
  );
}
async function deriveAddress(publicKeyJwk: string) {
  return "0x" + (await sha256hex(publicKeyJwk)).slice(0, 40);
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
  // Subtract pending spends
  const { data: pend } = await supa
    .from("blob_mempool").select("amount,fee,from_address").eq("from_address", address);
  for (const p of pend ?? []) bal -= Number(p.amount) + Number(p.fee ?? TX_FEE);
  return Math.max(0, bal);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { id, from, fromUsername, to, amount, signature, publicKey, timestamp } = body ?? {};

    if (typeof id !== "string" || !id.startsWith("0x")) return bad("invalid id");
    if (typeof from !== "string" || !from.startsWith("0x")) return bad("invalid from");
    if (typeof to !== "string" || !to.startsWith("0x") || to.length < 10) return bad("invalid to");
    if (from === to) return bad("self-send not allowed");
    if (typeof publicKey !== "string") return bad("missing publicKey");
    if (typeof signature !== "string") return bad("missing signature");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return bad("invalid amount");
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return bad("invalid timestamp");
    // Reject heavily skewed timestamps (±10 min)
    if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return bad("timestamp out of window");

    // Address must match publicKey
    const derived = await deriveAddress(publicKey);
    if (derived !== from) return bad("from does not match publicKey");

    // Verify signature over canonical payload (must match client signing format)
    const payload = `${from}→${to}:${amt}@${ts}`;
    const okSig = await verifyEcdsa(publicKey, signature, payload);
    if (!okSig) return bad("bad signature");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Server-computed balance check
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
