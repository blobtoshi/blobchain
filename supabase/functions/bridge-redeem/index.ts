// Reverse bridge: WBLOB (Solana SPL) → BLOB (Blob Chain).
//
// SDK-free implementation: verifies the Solana burn via raw JSON-RPC
// (no @solana/web3.js, no @solana/spl-token) so we stay well under
// Supabase Edge Function CPU budget. Long-term goal: this exact code
// runs unchanged inside future BLOB full nodes.
//
// Flow:
//   1. User burns WBLOB on Solana with a Memo program ix encoding `blob:<dest>`.
//   2. Client POSTs { sol_signature, blob_address, amount } here.
//   3. We insert a `pending` row (idempotent on sol_signature) and dispatch
//      verification + credit as a background task.
//   4. verifyAndCredit fetches the FINALIZED tx via JSON-RPC, confirms exactly
//      one matching burn (mint + amount) AND a memo binding the blob_address,
//      then atomically claims the row and signs+broadcasts a normal BLOB tx
//      from BRIDGE_ADDRESS to blob_address for `amount - BRIDGE_FEE_BLOB`.
//   5. GET ?sol_signature=... polls status (re-runs verify if still pending).
import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;
import * as secp from "https://esm.sh/@noble/secp256k1@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.5.0/sha256";
import { ripemd160 } from "https://esm.sh/@noble/hashes@1.5.0/ripemd160";
import { base58check } from "https://esm.sh/@scure/base@1.1.9";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// MUST match GENESIS.bridgeAddress in src/lib/blob/constants.ts (pinned at genesis).
const BRIDGE_ADDRESS = "13yfvVYknMVa6xoKhVSrFHrshBBQv6rbvm";
const BRIDGE_FEE_BLOB = 0.0015;
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BLOB_UNIT = 1e8;
// wBLOB mint always has 8 decimals (matches BLOB chain). Hardcoded so we don't
// need to hit getMint() — saves an RPC call + bigint math is trivial.
const WBLOB_DECIMALS = 8;

const SOLANA_RPC_URL          = Deno.env.get("SOLANA_RPC_URL") ?? "";
const SOLANA_SPL_MINT_ADDRESS = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";
const BRIDGE_BLOB_PRIVATE_KEY = Deno.env.get("BRIDGE_BLOB_PRIVATE_KEY") ?? "";

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const BLOB_ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;

const enc = new TextEncoder();
const b58check = base58check(sha256);

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

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(b: Uint8Array): string {
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

type Supa = ReturnType<typeof createClient>;

async function sha256hex(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return bytesToHex(new Uint8Array(buf));
}

// ── Solana JSON-RPC ────────────────────────────────────────────────────
async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${method} http ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result as T;
}

// ── Verification ───────────────────────────────────────────────────────
type VerifyResult =
  | { ok: true; payer: string }
  | { ok: false; reason: string };

async function verifyBurn(sig: string, expectedAmount: number, expectedBlobAddr: string): Promise<VerifyResult> {
  if (!SOLANA_RPC_URL) return { ok: false, reason: "SOLANA_RPC_URL not configured" };
  if (!SOLANA_SPL_MINT_ADDRESS) return { ok: false, reason: "SOLANA_SPL_MINT_ADDRESS not configured" };

  let tx: any;
  try {
    tx = await solanaRpc("getTransaction", [
      sig,
      { maxSupportedTransactionVersion: 0, commitment: "finalized", encoding: "jsonParsed" },
    ]);
  } catch (e) {
    return { ok: false, reason: `rpc error: ${(e as Error).message}` };
  }
  if (!tx) return { ok: false, reason: "Solana tx not finalized yet" };
  if (tx.meta?.err) return { ok: false, reason: `Solana tx failed: ${JSON.stringify(tx.meta.err)}` };

  const ixs = (tx.transaction?.message?.instructions ?? []) as any[];
  const expectedMemo = `blob:${expectedBlobAddr}`;
  const expectedBase = BigInt(Math.round(expectedAmount * 10 ** WBLOB_DECIMALS));

  let burnCount = 0;
  let memoCount = 0;
  let burnAuthority: string | null = null;

  for (const ix of ixs) {
    const programId = ix.programId;

    // Memo program ix.
    if (programId === MEMO_PROGRAM_ID) {
      let memoText = "";
      if (typeof ix.parsed === "string") memoText = ix.parsed;
      else if (ix.parsed?.info?.memo) memoText = ix.parsed.info.memo;
      else if (typeof ix.data === "string") {
        try { memoText = new TextDecoder().decode(Uint8Array.from(atob(ix.data), c => c.charCodeAt(0))); }
        catch { /* ignore */ }
      }
      if (memoText !== expectedMemo) {
        return { ok: false, reason: `memo mismatch: expected "${expectedMemo}", got "${memoText}"` };
      }
      memoCount++;
      continue;
    }

    // SPL Token burn / burnChecked.
    if (programId === TOKEN_PROGRAM_ID && ix.parsed) {
      const ptype = ix.parsed.type;
      if (ptype === "burn" || ptype === "burnChecked") {
        const info = ix.parsed.info;
        if (info.mint !== SOLANA_SPL_MINT_ADDRESS) {
          return { ok: false, reason: `wrong mint: ${info.mint}` };
        }
        const amtStr = ptype === "burnChecked" ? info.tokenAmount?.amount : info.amount;
        const burned = BigInt(amtStr);
        if (burned !== expectedBase) {
          return { ok: false, reason: `burn amount mismatch: expected ${expectedBase} base units, got ${burned}` };
        }
        burnAuthority = info.authority ?? burnAuthority;
        burnCount++;
        continue;
      }
    }
  }

  if (burnCount !== 1) return { ok: false, reason: `expected exactly 1 burn ix, found ${burnCount}` };
  if (memoCount !== 1) return { ok: false, reason: `expected exactly 1 memo ix, found ${memoCount}` };

  const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey ?? "";
  if (burnAuthority && burnAuthority !== feePayer) {
    return { ok: false, reason: "burn authority does not match fee payer" };
  }

  return { ok: true, payer: feePayer };
}

// ── BLOB tx signing & broadcast ────────────────────────────────────────
async function signAndBroadcastCredit(
  blobAddress: string,
  creditAmount: number,
  solSig: string,
): Promise<{ ok: boolean; tx_id?: string; error?: string }> {
  if (!BRIDGE_BLOB_PRIVATE_KEY) return { ok: false, error: "BRIDGE_BLOB_PRIVATE_KEY not configured" };

  const privBytes = hexToBytes(BRIDGE_BLOB_PRIVATE_KEY.replace(/^0x/, ""));
  const pubBytes = secp.getPublicKey(privBytes, true);
  const pubHex = bytesToHex(pubBytes);
  const derivedAddr = pubKeyToAddress(pubHex);
  if (derivedAddr !== BRIDGE_ADDRESS) {
    return { ok: false, error: `BRIDGE_BLOB_PRIVATE_KEY derives ${derivedAddr}, expected ${BRIDGE_ADDRESS}` };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  let feeRate = 10;
  try {
    const fr = await fetch(`${supabaseUrl}/functions/v1/submit-tx`, {
      headers: { apikey: anonKey },
    });
    if (fr.ok) {
      const j = await fr.json();
      feeRate = Math.max(10, Number(j.recommendedFeeRate) || 10);
    }
  } catch { /* fall back to default */ }

  const ts = Date.now();
  const memo = `redeem:${solSig.slice(0, 16)}`;
  const amt = Math.round(creditAmount * BLOB_UNIT) / BLOB_UNIT;

  const data = `${BRIDGE_ADDRESS}→${blobAddress}:${amt}@${ts}|fr=${feeRate}|m=${memo}`;
  const msgHash = sha256(enc.encode(data));
  const sigObj = await secp.signAsync(msgHash, privBytes);
  const signature = sigObj.toCompactHex();

  const txid = (await sha256hex(`${BRIDGE_ADDRESS}${blobAddress}${amt}${ts}${feeRate}${memo}`)).slice(0, 40);

  const body = {
    id: txid,
    from: BRIDGE_ADDRESS,
    to: blobAddress,
    amount: amt,
    feeRate,
    memo,
    signature,
    publicKey: pubHex,
    timestamp: ts,
  };

  const res = await fetch(`${supabaseUrl}/functions/v1/submit-tx`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: anonKey },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) return { ok: false, error: j.error || `submit-tx ${res.status}` };
  return { ok: true, tx_id: txid };
}

// ── Verify + credit pipeline ───────────────────────────────────────────
async function verifyAndCredit(supa: Supa, solSig: string) {
  const { data: row } = await supa.from("bridge_redeems")
    .select("*").eq("sol_signature", solSig).maybeSingle();
  if (!row) return;
  if (row.status === "credited" || row.status === "failed" || row.status === "crediting") return;

  // Step 1 — verify (skip if already verified).
  if (row.status === "pending") {
    const v = await verifyBurn(solSig, Number(row.amount), row.blob_address);
    if (!v.ok) {
      if (/not finalized yet/.test(v.reason)) return;
      await supa.from("bridge_redeems")
        .update({ status: "failed", error: v.reason })
        .eq("sol_signature", solSig);
      return;
    }
    const credit = Math.round((Number(row.amount) - BRIDGE_FEE_BLOB) * BLOB_UNIT) / BLOB_UNIT;
    if (credit <= 0) {
      await supa.from("bridge_redeems")
        .update({ status: "failed", error: `amount below bridge fee (${BRIDGE_FEE_BLOB} BLOB)` })
        .eq("sol_signature", solSig);
      return;
    }
    await supa.from("bridge_redeems")
      .update({
        status: "verified",
        credit_amount: credit,
        bridge_fee: BRIDGE_FEE_BLOB,
        verified_at: new Date().toISOString(),
      })
      .eq("sol_signature", solSig);
    row.status = "verified";
    row.credit_amount = credit;
  }

  // Step 2 — atomic claim.
  const { data: claimed } = await supa.from("bridge_redeems")
    .update({ status: "crediting" })
    .eq("sol_signature", solSig)
    .eq("status", "verified")
    .select().maybeSingle();
  if (!claimed) return;

  // Step 3 — sign + broadcast credit tx.
  const credit = Number(claimed.credit_amount);
  const r = await signAndBroadcastCredit(claimed.blob_address, credit, solSig);
  if (!r.ok) {
    await supa.from("bridge_redeems")
      .update({ status: "verified", error: r.error?.slice(0, 500) ?? "credit failed" })
      .eq("sol_signature", solSig);
    return;
  }

  await supa.from("bridge_redeems")
    .update({
      status: "credited",
      blob_tx_id: r.tx_id!,
      credited_at: new Date().toISOString(),
      error: null,
    })
    .eq("sol_signature", solSig);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);

  if (req.method === "GET") {
    const sig = url.searchParams.get("sol_signature") ?? "";
    if (!SIG_RE.test(sig)) return bad("invalid sol_signature");
    const { data: row } = await supa.from("bridge_redeems")
      .select("*").eq("sol_signature", sig).maybeSingle();
    if (!row) return bad("not found", 404);
    if (row.status === "pending" || row.status === "verified") {
      // @ts-ignore EdgeRuntime is provided by the Supabase Edge runtime.
      EdgeRuntime.waitUntil(verifyAndCredit(supa, sig));
    }
    return ok_(row);
  }

  if (req.method !== "POST") return bad("method not allowed", 405);

  try {
    const body = await req.json();
    const { sol_signature, blob_address, amount } = body ?? {};
    if (typeof sol_signature !== "string" || !SIG_RE.test(sol_signature)) return bad("invalid sol_signature");
    if (typeof blob_address !== "string" || !BLOB_ADDR_RE.test(blob_address)) return bad("invalid blob_address");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return bad("invalid amount");

    const { data: existing } = await supa.from("bridge_redeems")
      .select("*").eq("sol_signature", sol_signature).maybeSingle();

    let row = existing;
    if (!row) {
      const { data: inserted, error: insErr } = await supa.from("bridge_redeems")
        .insert({
          sol_signature,
          blob_address,
          amount: amt,
          status: "pending",
        })
        .select().single();
      if (insErr) {
        console.error("[bridge-redeem] redeem insert failed", insErr);
        return bad("internal error", 500);
      }
      row = inserted;
    }

    // @ts-ignore EdgeRuntime
    EdgeRuntime.waitUntil(verifyAndCredit(supa, sol_signature));
    return ok_(row);
  } catch (e) {
    console.error("[bridge-redeem] unexpected error", e);
    return bad("internal error", 500);
  }
});
