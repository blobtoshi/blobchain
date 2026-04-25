// Registers a freshly-created (or imported) wallet in blob_players so that
// the address is visible in the explorer immediately. Signature-gated so
// only the keypair owner can claim the address slot.
import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import * as secp from "https://esm.sh/@noble/secp256k1@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "https://esm.sh/@noble/hashes@1.5.0/ripemd160";
import { base58check } from "https://esm.sh/@scure/base@1.1.9";

const enc = new TextEncoder();
const b58check = base58check(sha256);

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("bad hex");
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

const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json();
    const { address, publicKey, signature, timestamp } = body ?? {};

    if (typeof address !== "string" || !ADDR_RE.test(address)) return bad("invalid address");
    if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return bad("invalid publicKey");
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return bad("invalid signature");
    if (typeof timestamp !== "number") return bad("invalid timestamp");

    const skew = Math.abs(Date.now() - timestamp);
    if (skew > 5 * 60 * 1000) return bad("stale registration");

    const derived = pubKeyToAddress(publicKey.toLowerCase());
    if (derived !== address) return bad("address does not match publicKey");

    const payload = `register:${address}:${timestamp}`;
    if (!verifySig(publicKey, signature, payload)) return bad("bad signature");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await supa.from("blob_players").upsert({
      address,
      public_key: publicKey,
      last_active: new Date().toISOString(),
    }, { onConflict: "address" });
    if (error) {
      console.error("[register-player] upsert failed", error);
      return bad("internal error", 500);
    }

    return ok_({ address });
  } catch (e) {
    console.error("[register-player] unexpected error", e);
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
