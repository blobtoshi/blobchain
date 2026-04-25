// Dedicated SPL mint executor — hand-built, NO Solana SDKs.
// Uses raw JSON-RPC + @noble/ed25519 + @noble/hashes + bs58.
// This eliminates the WORKER_RESOURCE_LIMIT cold-start CPU issue caused by
// @solana/web3.js + @solana/spl-token, and aligns with the long-term goal of
// zero vendor-SDK lock-in (so this same code can run inside a future BlobChain
// full node without modification).

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

// ---- Solana program IDs ----
const TOKEN_PROGRAM_ID            = bs58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = bs58.decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM_ID           = new Uint8Array(32); // all zeros = 11111111111111111111111111111111

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- JSON-RPC helper ----
async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// ---- PDA derivation (find_program_address) ----
// Implements the Solana PDA algorithm: hash(seeds || bump || program_id || "ProgramDerivedAddress")
// until the result is OFF the ed25519 curve.
function isOnCurve(pub: Uint8Array): boolean {
  try {
    // Decompress; throws if not a valid curve point.
    ed.ExtendedPoint.fromHex(pub);
    return true;
  } catch {
    return false;
  }
}

function createProgramAddress(seeds: Uint8Array[], programId: Uint8Array): Uint8Array | null {
  const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");
  let total = 0;
  for (const s of seeds) total += s.length;
  const buf = new Uint8Array(total + programId.length + PDA_MARKER.length);
  let o = 0;
  for (const s of seeds) { buf.set(s, o); o += s.length; }
  buf.set(programId, o); o += programId.length;
  buf.set(PDA_MARKER, o);
  const h = sha256(buf);
  if (isOnCurve(h)) return null;
  return h;
}

function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): { address: Uint8Array; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const seedsWithBump = [...seeds, new Uint8Array([bump])];
    const addr = createProgramAddress(seedsWithBump, programId);
    if (addr) return { address: addr, bump };
  }
  throw new Error("unable to find PDA");
}

function getATA(owner: Uint8Array, mint: Uint8Array): Uint8Array {
  return findProgramAddress(
    [owner, TOKEN_PROGRAM_ID, mint],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  ).address;
}

// ---- Compact-u16 (Solana shortvec) ----
function encodeShortVec(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (true) {
    let b = v & 0x7f;
    v >>>= 7;
    if (v === 0) { out.push(b); break; }
    b |= 0x80;
    out.push(b);
  }
  return new Uint8Array(out);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, n, true);
  return out;
}

// ---- Transaction builder ----
type AccountMeta = { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean };
type Instruction = { programId: Uint8Array; keys: AccountMeta[]; data: Uint8Array };

function buildMessage(
  feePayer: Uint8Array,
  recentBlockhash: Uint8Array,
  instructions: Instruction[],
): { message: Uint8Array; accountKeys: Uint8Array[] } {
  // Collect unique account keys with metadata. Fee payer always first, signer & writable.
  const metas = new Map<string, AccountMeta>();
  const key = (p: Uint8Array) => bs58.encode(p);

  const upsert = (m: AccountMeta) => {
    const k = key(m.pubkey);
    const ex = metas.get(k);
    if (!ex) metas.set(k, { ...m });
    else {
      ex.isSigner ||= m.isSigner;
      ex.isWritable ||= m.isWritable;
    }
  };

  upsert({ pubkey: feePayer, isSigner: true, isWritable: true });
  for (const ix of instructions) {
    for (const k of ix.keys) upsert(k);
    upsert({ pubkey: ix.programId, isSigner: false, isWritable: false });
  }

  // Order: signers-writable, signers-readonly, non-signers-writable, non-signers-readonly.
  // Fee payer must be index 0.
  const all = [...metas.values()];
  const feePayerKey = key(feePayer);
  all.sort((a, b) => {
    if (key(a.pubkey) === feePayerKey) return -1;
    if (key(b.pubkey) === feePayerKey) return 1;
    const rank = (m: AccountMeta) =>
      (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1);
    return rank(a) - rank(b);
  });

  let numSigners = 0, numReadonlySigners = 0, numReadonlyNonSigners = 0;
  for (const m of all) {
    if (m.isSigner) {
      numSigners++;
      if (!m.isWritable) numReadonlySigners++;
    } else if (!m.isWritable) numReadonlyNonSigners++;
  }

  const accountKeys = all.map(m => m.pubkey);
  const indexOf = (p: Uint8Array) => accountKeys.findIndex(a => bs58.encode(a) === bs58.encode(p));

  // Compile instructions
  const compiled: Uint8Array[] = [];
  for (const ix of instructions) {
    const programIdIndex = indexOf(ix.programId);
    const accountIndices = new Uint8Array(ix.keys.map(k => indexOf(k.pubkey)));
    compiled.push(concat(
      new Uint8Array([programIdIndex]),
      encodeShortVec(accountIndices.length),
      accountIndices,
      encodeShortVec(ix.data.length),
      ix.data,
    ));
  }

  // Header
  const header = new Uint8Array([numSigners, numReadonlySigners, numReadonlyNonSigners]);

  // Account keys array
  const keysBlob = concat(encodeShortVec(accountKeys.length), ...accountKeys);

  // Instructions array
  const ixBlob = concat(encodeShortVec(compiled.length), ...compiled);

  const message = concat(header, keysBlob, recentBlockhash, ixBlob);
  return { message, accountKeys };
}

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

    // ---- Load authority keypair ----
    const raw = SOLANA_MINT_AUTHORITY.trim();
    let secretKey: Uint8Array;
    if (raw.startsWith("[")) {
      secretKey = Uint8Array.from(JSON.parse(raw));
    } else {
      secretKey = bs58.decode(raw);
    }
    if (secretKey.length !== 64) return bad("authority secret key must be 64 bytes");
    const privKey = secretKey.slice(0, 32);
    const authorityPub = secretKey.slice(32, 64); // public key is last 32 bytes of solana keypair format

    const mintPub = bs58.decode(SOLANA_SPL_MINT_ADDRESS);
    const recipientPub = bs58.decode(recipient);
    if (mintPub.length !== 32 || recipientPub.length !== 32) return bad("invalid pubkey length");

    // ---- Fetch mint decimals ----
    const mintAcct = await rpc<any>("getAccountInfo", [
      SOLANA_SPL_MINT_ADDRESS,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!mintAcct?.value?.data?.[0]) return bad("mint account not found", 500);
    const mintData = Uint8Array.from(atob(mintAcct.value.data[0]), c => c.charCodeAt(0));
    // SPL Mint layout: decimals at offset 44 (after mint_authority_option(4) + mint_authority(32) + supply(8))
    const decimals = mintData[44];
    const baseUnits = BigInt(Math.round(amt * 10 ** decimals));
    if (baseUnits <= 0n) return bad("amount rounds to zero base units");

    // ---- Derive ATA ----
    const ata = getATA(recipientPub, mintPub);

    // ---- Build instructions ----
    // 1) ATA-create-idempotent (instruction discriminator = 1)
    const createAtaIx: Instruction = {
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: authorityPub, isSigner: true,  isWritable: true  }, // funding
        { pubkey: ata,          isSigner: false, isWritable: true  }, // ata
        { pubkey: recipientPub, isSigner: false, isWritable: false }, // owner
        { pubkey: mintPub,      isSigner: false, isWritable: false }, // mint
        { pubkey: SYSTEM_PROGRAM_ID,  isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]), // CreateIdempotent
    };

    // 2) MintTo (Token instruction tag = 7, then u64 amount LE)
    const mintToIx: Instruction = {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: mintPub,       isSigner: false, isWritable: true  },
        { pubkey: ata,           isSigner: false, isWritable: true  },
        { pubkey: authorityPub,  isSigner: true,  isWritable: false },
      ],
      data: concat(new Uint8Array([7]), u64le(baseUnits)),
    };

    // ---- Get recent blockhash ----
    const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "finalized" }]);
    const blockhashB58: string = bh.value.blockhash;
    const recentBlockhash = bs58.decode(blockhashB58);

    // ---- Build & sign message ----
    const { message } = buildMessage(authorityPub, recentBlockhash, [createAtaIx, mintToIx]);
    const signature = await ed.signAsync(message, privKey);

    // ---- Encode wire transaction ----
    // [shortvec(numSigs)][sig0..sigN-1][message]
    const wire = concat(encodeShortVec(1), signature, message);
    const wireB64 = btoa(String.fromCharCode(...wire));

    // ---- Send ----
    const sigStr = await rpc<string>("sendTransaction", [
      wireB64,
      { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 },
    ]);

    // ---- Poll for confirmation (up to ~30s) ----
    let confirmed = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const st = await rpc<any>("getSignatureStatuses", [[sigStr], { searchTransactionHistory: false }]);
      const s = st?.value?.[0];
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
        if (s.err) throw new Error(`tx failed on-chain: ${JSON.stringify(s.err)}`);
        confirmed = true;
        break;
      }
    }
    if (!confirmed) {
      // Return signature anyway — caller can poll separately.
      return new Response(JSON.stringify({ signature: sigStr, confirmed: false }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ signature: sigStr, confirmed: true }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error("[bridge-execute-mint] error", msg);
    return bad(msg, 500);
  }
});
