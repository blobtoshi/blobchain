// Verifies a secp256k1 (Bitcoin curve) signed mining entry, RE-SIMULATES
// the submitted gameplay trace deterministically, and only accepts the
// score if the replay matches. This is the consensus anti-cheat layer.
import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
// deno type-check chokes on the 2.95 generics; cast to any so call sites stay clean.
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;
import { corsHeaders } from "https://esm.sh/@supabase/supabase-js@2.95.0/cors";
import * as secp from "https://esm.sh/@noble/secp256k1@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "https://esm.sh/@noble/hashes@1.5.0/ripemd160";
import { base58check } from "https://esm.sh/@scure/base@1.1.9";
import {
  ENGINE_VERSION, MAX_FRAMES, parseCanonicalInputs,
  plausibilityCheck, simulate,
} from "./_simulator.ts";

const enc = new TextEncoder();
const b58check = base58check(sha256);

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array) {
  let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s;
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
async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return bytesToHex(new Uint8Array(buf));
}

const BLOCK_TIME = 120;
const GENESIS_TIME_MS = 1777084251161;
function timeBasedHeight() {
  const now = Math.floor(Date.now() / 1000);
  const genesis = Math.floor(GENESIS_TIME_MS / 1000);
  return Math.floor(Math.max(0, now - genesis) / BLOCK_TIME) + 1;
}

const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;
const HASH_RE = /^[0-9a-fA-F]{64}$/;
const SEED_RE = /^[0-9]+$/;

// Canonical input string is "f:t,f:t,..." — bound length to MAX_FRAMES * ~10 chars.
const MAX_INPUTS_STR = MAX_FRAMES * 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const {
      address, score, block_height, block_seed,
      signature, publicKey, frame_count, inputs, inputs_hash, engine_version,
    } = body ?? {};

    // ---- Static validation ----
    if (typeof address !== "string" || !ADDR_RE.test(address)) return bad("invalid address");
    if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return bad("invalid publicKey");
    if (typeof signature !== "string" || !SIG_RE.test(signature)) return bad("invalid signature");
    if (typeof block_height !== "number" || block_height < 1) return bad("invalid block_height");
    const sc = Number(score);
    if (!Number.isFinite(sc) || sc < 0 || sc > 10_000_000) return bad("invalid score");
    if (typeof block_seed !== "string" || !SEED_RE.test(block_seed)) return bad("invalid block_seed");
    if (typeof frame_count !== "number" || !Number.isInteger(frame_count)) return bad("invalid frame_count");
    if (typeof inputs !== "string" || inputs.length > MAX_INPUTS_STR) return bad("invalid inputs trace");
    if (typeof inputs_hash !== "string" || !HASH_RE.test(inputs_hash)) return bad("invalid inputs_hash");
    if (engine_version !== ENGINE_VERSION) return bad(`engine_version mismatch (expected ${ENGINE_VERSION})`);

    // ---- Address ↔ pubkey binding ----
    const derived = pubKeyToAddress(publicKey.toLowerCase());
    if (derived !== address) return bad("address does not match publicKey");

    // ---- Block must be the active block ----
    const supaCheck = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: tip } = await supaCheck
      .from("blob_chain").select("height,seed").order("height", { ascending: false }).limit(1).maybeSingle();
    const activeHeight = Number(tip?.height ?? 0) + 1;
    const tHeight = timeBasedHeight();
    if (block_height !== activeHeight) return bad(`stale block_height (active is #${activeHeight})`);
    if (block_height > tHeight) return bad("block not yet open");

    // ---- Verify inputs_hash matches the trace ----
    const computedHash = await sha256hex(inputs);
    if (computedHash !== inputs_hash) return bad("inputs_hash does not match trace");

    // ---- Verify signature over canonical payload (now includes inputs hash) ----
    const payload = `${block_height}:${address}:${Math.floor(sc)}:${inputs_hash}`;
    if (!verifySig(publicKey, signature, payload)) return bad("bad signature");

    // ---- Plausibility ----
    const events = inputs.length === 0 ? [] : parseCanonicalInputs(inputs);
    const plaus = plausibilityCheck(events, frame_count, Math.floor(sc));
    if (plaus) return bad(`replay rejected: ${plaus}`);

    // ---- Deterministic re-simulation (THE consensus check) ----
    const seedNum = Number(block_seed);
    if (!Number.isFinite(seedNum)) return bad("seed not numeric");
    const result = simulate(seedNum, events, frame_count);
    if (!result.dead) return bad("replay did not terminate (player still alive)");
    if (result.frame !== frame_count) return bad(`frame_count mismatch (replay=${result.frame})`);
    if (result.score !== Math.floor(sc)) return bad(`score mismatch (replay=${result.score})`);
    if (result.score === 0) return bad("replay rejected: must clear first obstacle");

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ---- Persist (keep highest verified score) ----
    const { data: existing } = await supa
      .from("blob_entries").select("score").eq("address", address).eq("block_height", block_height).maybeSingle();
    const finalScore = Math.max(Math.floor(sc), existing?.score ?? 0);
    const persistedInputs = finalScore === Math.floor(sc) ? inputs : null; // only keep trace for current best
    const persistedHash = finalScore === Math.floor(sc) ? inputs_hash : null;
    const persistedFrames = finalScore === Math.floor(sc) ? frame_count : null;

    const { error } = await supa.from("blob_entries").upsert({
      address, score: finalScore, block_height,
      block_seed: String(block_seed), signature,
      inputs: persistedInputs, inputs_hash: persistedHash, frame_count: persistedFrames,
    }, { onConflict: "address,block_height" });

    if (error) {
      console.error("[submit-entry] entry insert failed", error);
      return bad("internal error", 500);
    }

    const { error: pErr } = await supa.from("blob_addresses").upsert({
      address, public_key: publicKey, last_active: new Date().toISOString(),
    }, { onConflict: "address" });
    if (pErr) {
      console.error("[submit-entry] address upsert failed", pErr);
      return bad("internal error", 500);
    }

    return ok_({ address, block_height, score: finalScore, verified: true });
  } catch (e) {
    console.error("[submit-entry] unexpected error", e);
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
