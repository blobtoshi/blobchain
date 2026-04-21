// Verifies an ECDSA P-256 signed mining entry and upserts it.
// Public RLS writes are disabled; this function uses the service role.
import { createClient } from "npm:@supabase/supabase-js@2.95.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2.95.0/cors";

const enc = new TextEncoder();

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function verifyEcdsa(publicKeyJwk: string, signatureHex: string, data: string) {
  const jwk = JSON.parse(publicKeyJwk);
  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    hexToBytes(signatureHex),
    enc.encode(data),
  );
}

async function deriveAddress(publicKeyJwk: string) {
  return "0x" + (await sha256hex(publicKeyJwk)).slice(0, 40);
}

const BLOCK_TIME = 120;
const GENESIS_TIME_MS = 1745000000000;
function currentHeight() {
  const now = Math.floor(Date.now() / 1000);
  const genesis = Math.floor(GENESIS_TIME_MS / 1000);
  return Math.floor(Math.max(0, now - genesis) / BLOCK_TIME) + 1;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { address, username, score, block_height, block_seed, signature, publicKey } = body ?? {};

    // Basic shape validation
    if (typeof address !== "string" || !address.startsWith("0x")) return bad("invalid address");
    if (typeof publicKey !== "string") return bad("missing publicKey");
    if (typeof signature !== "string" || !signature.length) return bad("missing signature");
    if (typeof block_height !== "number" || block_height < 1) return bad("invalid block_height");
    const sc = Number(score);
    if (!Number.isFinite(sc) || sc < 0 || sc > 10_000_000) return bad("invalid score");
    if (username && typeof username === "string" && username.length > 24) return bad("username too long");

    // Address must match publicKey
    const derived = await deriveAddress(publicKey);
    if (derived !== address) return bad("address does not match publicKey");

    // Block height must be current (no backfill, no future)
    const cur = currentHeight();
    if (block_height !== cur) return bad("stale block_height");

    // Verify signature over canonical entry payload
    const payload = `${block_height}:${address}:${Math.floor(sc)}`;
    const ok = await verifyEcdsa(publicKey, signature, payload);
    if (!ok) return bad("bad signature");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Keep best score per (address, height)
    const { data: existing } = await supa
      .from("blob_entries")
      .select("score")
      .eq("address", address)
      .eq("block_height", block_height)
      .maybeSingle();

    const finalScore = Math.max(Math.floor(sc), existing?.score ?? 0);

    const { error } = await supa.from("blob_entries").upsert({
      address,
      username: username?.toString().slice(0, 24) ?? null,
      score: finalScore,
      block_height,
      block_seed: block_seed ? String(block_seed) : null,
      signature,
    }, { onConflict: "address,block_height" });

    if (error) return bad(error.message, 500);

    // Best-effort: refresh public_key on player record for future verification UX
    await supa.from("blob_players").upsert({
      address,
      username: username?.toString().slice(0, 24) ?? "anon",
      public_key: publicKey,
      last_active: new Date().toISOString(),
    }, { onConflict: "address" });

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
