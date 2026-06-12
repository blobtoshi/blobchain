// Input:  { recipient: string, amount: number, blob_tx_id: string }
// Output: { signature: string, ata: string, recipient: string, amount: number }

import * as ed from "https://esm.sh/@noble/ed25519@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.4.0/sha256";
import bs58 from "https://esm.sh/bs58@5.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SOLANA_RPC_URL          = Deno.env.get("SOLANA_RPC_URL") ?? "";
const SOLANA_MINT_AUTHORITY   = Deno.env.get("SOLANA_MINT_AUTHORITY_SECRET_KEY") ?? "";
const SOLANA_SPL_MINT_ADDRESS = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";
const SERVICE_KEY             = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const TOKEN_PROGRAM_ID            = bs58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = bs58.decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM_ID           = new Uint8Array(32);

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ── PDA helpers ──────────────────────────────────────────────────────────────

function isOnCurve(pub: Uint8Array): boolean {
  try { ed.ExtendedPoint.fromHex(pub); return true; } catch { return false; }
}
function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array | null {
  const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
  let total = 0; for (const s of seeds) total += s.length;
  const buf = new Uint8Array(total + programId.length + PDA_MARKER.length);
  let o = 0;
  for (const s of seeds) { buf.set(s, o); o += s.length; }
  buf.set(programId, o); o += programId.length;
  buf.set(PDA_MARKER, o);
  const h = sha256(buf);
  return isOnCurve(h) ? null : h;
}
function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array) {
  for (let bump = 255; bump >= 0; bump--) {
    const addr = createProgramAddress([...seeds, new Uint8Array([bump])], programId);
    if (addr) return { address: addr, bump };
  }
  throw new Error("unable to find PDA");
}
function getATA(owner: Uint8Array, mint: Uint8Array): Uint8Array {
  return findProgramAddress([owner, TOKEN_PROGRAM_ID, mint], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}

// ── Wire helpers ─────────────────────────────────────────────────────────────

function encodeShortVec(n: number): Uint8Array {
  const out: number[] = []; let v = n;
  while (true) {
    let b = v & 0x7f; v >>>= 7;
    if (v === 0) { out.push(b); break; }
    b |= 0x80; out.push(b);
  }
  return new Uint8Array(out);
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0; for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

type AccountMeta = { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean };
type Instruction  = { programId: Uint8Array; keys: AccountMeta[]; data: Uint8Array };

function buildMessage(
  feePayer: Uint8Array,
  recentBlockhash: Uint8Array,
  instructions: Instruction[],
): { message: Uint8Array; accountKeys: Uint8Array[] } {
  const metas = new Map<string, AccountMeta>();
  const key = (p: Uint8Array) => bs58.encode(p);
  const upsert = (m: AccountMeta) => {
    const k = key(m.pubkey);
    const ex = metas.get(k);
    if (!ex) metas.set(k, { ...m });
    else { ex.isSigner ||= m.isSigner; ex.isWritable ||= m.isWritable; }
  };
  upsert({ pubkey: feePayer, isSigner: true, isWritable: true });
  for (const ix of instructions) {
    for (const k of ix.keys) upsert(k);
    upsert({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }
  const all = [...metas.values()];
  const feePayerKey = key(feePayer);
  all.sort((a, b) => {
    if (key(a.pubkey) === feePayerKey) return -1;
    if (key(b.pubkey) === feePayerKey) return 1;
    const rank = (m: AccountMeta) => (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1);
    return rank(a) - rank(b);
  });
  let numSigners = 0, numReadonlySigners = 0, numReadonlyNonSigners = 0;
  for (const m of all) {
    if (m.isSigner) { numSigners++; if (!m.isWritable) numReadonlySigners++; }
    else if (!m.isWritable) numReadonlyNonSigners++;
  }
  const accountKeys = all.map(m => m.pubkey);
  const indexOf = (p: Uint8Array) => accountKeys.findIndex(a => bs58.encode(a) === bs58.encode(p));
  const compiled: Uint8Array[] = [];
  for (const ix of instructions) {
    const programIdIndex = indexOf(ix.programId);
    const accountIndices = new Uint8Array(ix.keys.map(k => indexOf(k.pubkey)));
    compiled.push(concat(
      new Uint8Array([programIdIndex]),
      encodeShortVec(accountIndices.length), accountIndices,
      encodeShortVec(ix.data.length), ix.data,
    ));
  }
  const header  = new Uint8Array([numSigners, numReadonlySigners, numReadonlyNonSigners]);
  const keysBlob = concat(encodeShortVec(accountKeys.length), ...accountKeys);
  const ixBlob   = concat(encodeShortVec(compiled.length), ...compiled);
  return { message: concat(header, keysBlob, recentBlockhash, ixBlob), accountKeys };
}

// ── Confirmation polling ──────────────────────────────────────────────────────

async function waitForConfirmation(signature: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await rpc<any>("getSignatureStatuses", [
      [signature], { searchTransactionHistory: true },
    ]);
    const s = result?.value?.[0];
    if (s) {
      if (s.err) throw new Error(`tx failed on chain: ${JSON.stringify(s.err)}`);
      if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return;
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  // Timeout is non-fatal — the tx may still land. Callers should treat a
  // missing confirmation as "pending", not "failed".
  console.warn("[bridge-execute-mint] confirmation polling timed out for", signature);
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return bad("method not allowed", 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) return bad("unauthorized", 401);

  try {
    const { recipient, amount } = (await req.json()) ?? {};

    if (typeof recipient !== "string" || !SOL_ADDR_RE.test(recipient)) return bad("invalid recipient");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return bad("invalid amount");
    if (!SOLANA_RPC_URL || !SOLANA_MINT_AUTHORITY || !SOLANA_SPL_MINT_ADDRESS) {
      return bad("solana env missing", 500);
    }

    // Parse mint authority keypair (64-byte: [priv(32) | pub(32)] or base58)
    const raw = SOLANA_MINT_AUTHORITY.trim();
    const secretKey: Uint8Array = raw.startsWith("[")
      ? Uint8Array.from(JSON.parse(raw))
      : bs58.decode(raw);
    if (secretKey.length !== 64) return bad("authority secret key must be 64 bytes");
    const authPriv = secretKey.slice(0, 32);
    const authPub  = secretKey.slice(32, 64);

    const mintPub      = bs58.decode(SOLANA_SPL_MINT_ADDRESS);
    const recipientPub = bs58.decode(recipient);
    if (mintPub.length !== 32 || recipientPub.length !== 32) return bad("invalid pubkey length");

    // Get mint decimals
    const mintAcct = await rpc<any>("getAccountInfo", [
      SOLANA_SPL_MINT_ADDRESS, { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!mintAcct?.value?.data?.[0]) return bad("mint account not found", 500);
    const mintData  = Uint8Array.from(atob(mintAcct.value.data[0]), c => c.charCodeAt(0));
    const decimals  = mintData[44];
    const baseUnits = BigInt(Math.round(amt * 10 ** decimals));
    if (baseUnits <= 0n) return bad("amount rounds to zero base units");

    const ata = getATA(recipientPub, mintPub);

    // ── Build instructions ────────────────────────────────────────────────
    //
    // KEY CHANGE from co-signing flow:
    //   feePayer = authPub (mint authority), NOT recipientPub.
    //   This lets the backend mint fully autonomously after the BLOB deposit
    //   confirms, with no wallet popup needed from the user.
    //   The bridge operator absorbs the ~0.002 SOL ATA rent.

    const createAtaIx: Instruction = {
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: authPub,      isSigner: true,  isWritable: true  }, // funder = mint authority
        { pubkey: ata,          isSigner: false, isWritable: true  },
        { pubkey: recipientPub, isSigner: false, isWritable: false }, // ATA owner
        { pubkey: mintPub,      isSigner: false, isWritable: false },
        { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,  isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]), // CreateIdempotent
    };

    const mintToIx: Instruction = {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: mintPub, isSigner: false, isWritable: true  },
        { pubkey: ata,     isSigner: false, isWritable: true  },
        { pubkey: authPub, isSigner: true,  isWritable: false }, // mint authority
      ],
      data: concat(new Uint8Array([7]), u64le(baseUnits)),
    };

    const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "finalized" }]);
    const recentBlockhash = bs58.decode(bh.value.blockhash);

    // authPub is both fee payer AND mint authority → deduped to one account key,
    // one signer slot. numSigners = 1.
    const { message } = buildMessage(authPub, recentBlockhash, [createAtaIx, mintToIx]);

    const numSigners = message[0]; // should be 1
    if (numSigners !== 1) return bad(`unexpected signer count ${numSigners}`, 500);

    const authoritySig = await ed.signAsync(message, authPriv);

    // Fully-signed wire transaction
    const wire    = concat(encodeShortVec(1), authoritySig, message);
    const wireB64 = btoa(String.fromCharCode(...wire));

    // Broadcast
    const txSig = await rpc<string>("sendTransaction", [
      wireB64,
      { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 },
    ]);

    console.log("[bridge-execute-mint] broadcast", txSig, "for", recipient, amt);

    // Wait for on-chain confirmation (non-fatal timeout)
    await waitForConfirmation(txSig);

    return new Response(JSON.stringify({
      signature: txSig,
      ata:       bs58.encode(ata),
      recipient,
      amount:    amt,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error("[bridge-execute-mint] error", msg);
    return bad(msg, 500);
  }
});