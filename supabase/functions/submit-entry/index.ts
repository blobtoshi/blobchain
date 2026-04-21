// Verifies a secp256k1 (Bitcoin curve) signed mining entry and upserts it.
// Public RLS writes are disabled; this function uses the service role.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2.95.0/cors";
import * as secp from "npm:@noble/secp256k1@2.1.0";
import { sha256 } from "npm:@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "npm:@noble/hashes@1.5.0/ripemd160";
import { base58check } from "npm:@scure/base@1.1.9";

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

const BLOCK_TIME = 120;
const GENESIS_TIME_MS = 1776731760000;
function currentHeight() {
  const now = Math.floor(Date.now() / 1000);
  const genesis = Math.floor(GENESIS_TIME_MS / 1000);
  return Math.floor(Math.max(0, now - genesis) / BLOCK_TIME) + 1;
}

const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { address, username, score, block_height, block_seed, signature, publicKey } = body ?? {};

    if (typeof address !== "string" || !ADDR_RE.test(address)) return bad("invalid address");
    if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return bad("invalid publicKey");
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return bad("invalid signature");
    if (typeof block_height !== "number" || block_height < 1) return bad("invalid block_height");
    const sc = Number(score);
    if (!Number.isFinite(sc) || sc < 0 || sc > 10_000_000) return bad("invalid score");
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return bad("username must be 3–24 chars, letters/numbers/underscore");
    }

    // Address must match publicKey
    const derived = pubKeyToAddress(publicKey.toLowerCase());
    if (derived !== address) return bad("address does not match publicKey");

    // Block height must be current (no backfill, no future)
    const cur = currentHeight();
    if (block_height !== cur) return bad("stale block_height");

    // Verify signature over canonical entry payload
    const payload = `${block_height}:${address}:${Math.floor(sc)}`;
    if (!verifySig(publicKey, signature, payload)) return bad("bad signature");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Username uniqueness — usernames are global handles. If the name is
    // already owned by a different address, reject.
    const { data: nameOwner } = await supa
      .from("blob_players")
      .select("address")
      .ilike("username", username)
      .maybeSingle();
    if (nameOwner && nameOwner.address !== address) {
      return bad(`username "${username}" is taken`);
    }

    // Also reject if THIS address already has a different username on file
    // (one address ↔ one handle).
    const { data: addrOwner } = await supa
      .from("blob_players")
      .select("username")
      .eq("address", address)
      .maybeSingle();
    if (addrOwner && addrOwner.username && addrOwner.username.toLowerCase() !== username.toLowerCase()) {
      return bad(`address already registered as "${addrOwner.username}"`);
    }

    const { data: existing } = await supa
      .from("blob_entries")
      .select("score")
      .eq("address", address)
      .eq("block_height", block_height)
      .maybeSingle();

    const finalScore = Math.max(Math.floor(sc), existing?.score ?? 0);

    const { error } = await supa.from("blob_entries").upsert({
      address,
      username,
      score: finalScore,
      block_height,
      block_seed: block_seed ? String(block_seed) : null,
      signature,
    }, { onConflict: "address,block_height" });

    if (error) return bad(error.message, 500);

    const { error: pErr } = await supa.from("blob_players").upsert({
      address,
      username,
      public_key: publicKey,
      last_active: new Date().toISOString(),
    }, { onConflict: "address" });
    if (pErr) {
      // 23505 = unique violation on lower(username)
      if ((pErr as any).code === "23505") return bad(`username "${username}" is taken`);
      return bad(pErr.message, 500);
    }

    return ok_({ address, block_height, score: finalScore });
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
