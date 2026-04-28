// Solana bridge — fully in-node implementation.
//
// Forward (BLOB → wBLOB):
//   1. POST /bridge/mint { blob_tx_id, sol_address, amount, from_address }
//      → record bridge_requests row idempotently, then drive the state machine.
//   2. State machine: pending → confirmed (when the BLOB tx lands in a sealed
//      block here) → minting → minted (after SPL mint succeeds on Solana).
//   3. A background interval re-runs `processOnce` every few seconds to pick
//      up rows that need progressing (e.g. tx just sealed).
//
// Reverse (wBLOB → BLOB):
//   1. POST /bridge/redeem { sol_signature, blob_address, amount }
//      → record bridge_redeems row, kick verifyAndCredit.
//   2. Fetches the finalized Solana tx, verifies single burn ix + memo
//      `blob:<blob_address>`, signs a BLOB tx from BRIDGE_ADDRESS to
//      blob_address for `amount - BRIDGE_FEE_BLOB`, ingests it via the local
//      mempool (no HTTP round-trip).
//
// All Solana interaction is raw JSON-RPC + @noble/ed25519 — no @solana/web3.js.
// This is the same code shape as the edge functions, but split across no
// network boundaries and with no per-request CPU budget.

import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import * as secp from "@noble/secp256k1";
import type { DB } from "./db.js";
import { ingestTx } from "./ingest.js";
import { pubKeyToAddress, sha256hex, hexToBytes, bytesToHex } from "./crypto.js";
import { recommendedFeeRate } from "./validate.js";
import { BLOB_UNIT } from "./consensus.js";

// MUST match GENESIS.bridgeAddress in src/lib/blob/constants.ts.
export const BRIDGE_ADDRESS = "1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs";
const BRIDGE_FEE_BLOB = 0.0015;
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WBLOB_DECIMALS = 8;

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BLOB_ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const TX_ID_RE = /^[0-9a-fA-F]{8,64}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

// Required env. If any are missing, the bridge endpoints reply 503 and the
// worker stays idle — the rest of the node still functions normally.
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "";
const SOLANA_SPL_MINT_ADDRESS = process.env.SOLANA_SPL_MINT_ADDRESS ?? "";
const SOLANA_MINT_AUTHORITY = process.env.SOLANA_MINT_AUTHORITY_SECRET_KEY ?? "";
const BRIDGE_BLOB_PRIVATE_KEY = process.env.BRIDGE_BLOB_PRIVATE_KEY ?? "";

export function bridgeEnabled(): boolean {
  return Boolean(SOLANA_RPC_URL && SOLANA_SPL_MINT_ADDRESS && SOLANA_MINT_AUTHORITY && BRIDGE_BLOB_PRIVATE_KEY);
}

export function bridgeConfig() {
  return {
    bridgeAddress: BRIDGE_ADDRESS,
    splMintAddress: SOLANA_SPL_MINT_ADDRESS || null,
    solanaRpcUrl: SOLANA_RPC_URL || null,
    enabled: bridgeEnabled(),
  };
}

// ── DB schema (called once from openDb wrapper) ────────────────────────
export function ensureBridgeSchema(db: DB) {
  db.db.exec(`
    CREATE TABLE IF NOT EXISTS bridge_requests (
      blob_tx_id    TEXT PRIMARY KEY,
      from_address  TEXT NOT NULL,
      sol_address   TEXT NOT NULL,
      amount        REAL NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      sol_signature TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      confirmed_at  INTEGER,
      minted_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS bridge_requests_status_idx ON bridge_requests(status);

    CREATE TABLE IF NOT EXISTS bridge_redeems (
      sol_signature TEXT PRIMARY KEY,
      blob_address  TEXT NOT NULL,
      amount        REAL NOT NULL,
      credit_amount REAL,
      bridge_fee    REAL,
      status        TEXT NOT NULL DEFAULT 'pending',
      blob_tx_id    TEXT,
      error         TEXT,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      verified_at   INTEGER,
      credited_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS bridge_redeems_status_idx ON bridge_redeems(status);
  `);
}

// ── Forward: BLOB → wBLOB ──────────────────────────────────────────────
type BridgeRow = {
  blob_tx_id: string;
  from_address: string;
  sol_address: string;
  amount: number;
  status: string;
  sol_signature: string | null;
  error: string | null;
  created_at: number;
  confirmed_at: number | null;
  minted_at: number | null;
};

function findConfirmedBridgeTxInChain(d: DB, txId: string, fromAddress: string | null, amount: number | null) {
  // Walk recent blocks first (likely match) up to a hard cap.
  const rows = d.db.prepare<[number], { height: number; transactions: string }>(
    `SELECT height, transactions FROM blocks ORDER BY height DESC LIMIT ?`,
  ).all(500);
  for (const b of rows) {
    let txs: any[] = [];
    try { txs = JSON.parse(b.transactions); } catch { continue; }
    for (const tx of txs) {
      if (tx.id !== txId) continue;
      if (tx.to !== BRIDGE_ADDRESS) continue;
      if (fromAddress && tx.from !== fromAddress) continue;
      if (amount != null && Number(tx.amount) !== Number(amount)) continue;
      return { tx, height: b.height, memo: typeof tx.memo === "string" ? tx.memo : "" };
    }
  }
  return null;
}

function extractSolFromMemo(memo: unknown): string {
  if (typeof memo !== "string") return "";
  const m = memo.match(/^sol:([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  return m ? m[1] : "";
}

function getBridgeRow(d: DB, txId: string): BridgeRow | null {
  return d.db.prepare<[string], BridgeRow>(`SELECT * FROM bridge_requests WHERE blob_tx_id = ?`).get(txId) ?? null;
}

function upsertBridgeRow(d: DB, r: Partial<BridgeRow> & { blob_tx_id: string }) {
  const ex = getBridgeRow(d, r.blob_tx_id);
  if (!ex) {
    d.db.prepare(`
      INSERT INTO bridge_requests
        (blob_tx_id, from_address, sol_address, amount, status, sol_signature, error, created_at, confirmed_at, minted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.blob_tx_id, r.from_address!, r.sol_address!, r.amount!, r.status ?? "pending",
      r.sol_signature ?? null, r.error ?? null, Date.now(),
      r.confirmed_at ?? null, r.minted_at ?? null,
    );
    return getBridgeRow(d, r.blob_tx_id)!;
  }
  d.db.prepare(`
    UPDATE bridge_requests SET
      status = COALESCE(?, status),
      sol_signature = COALESCE(?, sol_signature),
      error = ?,
      confirmed_at = COALESCE(?, confirmed_at),
      minted_at = COALESCE(?, minted_at)
    WHERE blob_tx_id = ?
  `).run(
    r.status ?? null, r.sol_signature ?? null, r.error ?? null,
    r.confirmed_at ?? null, r.minted_at ?? null, r.blob_tx_id,
  );
  return getBridgeRow(d, r.blob_tx_id)!;
}

export type RegisterMintInput = {
  blob_tx_id: string;
  sol_address: string;
  amount: number;
  from_address: string;
};

export function registerMint(d: DB, body: RegisterMintInput): { ok: boolean; row?: BridgeRow; error?: string } {
  const { blob_tx_id, sol_address, amount, from_address } = body;
  if (!TX_ID_RE.test(blob_tx_id)) return { ok: false, error: "invalid blob_tx_id" };
  if (!SOL_ADDR_RE.test(sol_address)) return { ok: false, error: "invalid sol_address" };
  if (!BLOB_ADDR_RE.test(from_address)) return { ok: false, error: "invalid from_address" };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return { ok: false, error: "invalid amount" };

  // Check mempool.
  const inMempool = d.db.prepare<[string], { from_address: string; to_address: string; amount: number; memo: string | null }>(
    `SELECT from_address, to_address, amount, memo FROM mempool WHERE id = ?`,
  ).get(blob_tx_id);
  let memo = "";
  let foundFrom: string | null = null;
  if (inMempool && inMempool.to_address === BRIDGE_ADDRESS && inMempool.from_address === from_address && Number(inMempool.amount) === amt) {
    memo = inMempool.memo ?? "";
    foundFrom = inMempool.from_address;
  } else {
    const confirmed = findConfirmedBridgeTxInChain(d, blob_tx_id, from_address, amt);
    if (confirmed) {
      memo = confirmed.memo;
      foundFrom = confirmed.tx.from;
    }
  }
  if (!foundFrom) return { ok: false, error: "matching BLOB transaction not found in mempool or chain" };

  const memoSol = extractSolFromMemo(memo);
  if (!memoSol) return { ok: false, error: "originating tx is missing a valid sol: memo" };
  if (memoSol !== sol_address) return { ok: false, error: "sol_address does not match tx memo" };

  const isConfirmed = !inMempool;
  const row = upsertBridgeRow(d, {
    blob_tx_id, from_address, sol_address, amount: amt,
    status: isConfirmed ? "confirmed" : "pending",
    confirmed_at: isConfirmed ? Date.now() : null,
  });
  return { ok: true, row };
}

/** Called periodically. Advances any rows that can move forward. */
export async function processForwardOnce(d: DB, log: (level: "info" | "warn" | "error", m: string, e?: unknown) => void) {
  if (!bridgeEnabled()) return;
  const rows = d.db.prepare<[], BridgeRow>(
    `SELECT * FROM bridge_requests WHERE status IN ('pending','confirmed') ORDER BY created_at ASC LIMIT 20`,
  ).all();
  for (const row of rows) {
    try {
      await advanceForward(d, row, log);
    } catch (e) {
      log("error", `bridge-mint advance ${row.blob_tx_id}`, { err: String((e as Error)?.message ?? e) });
    }
  }
}

async function advanceForward(d: DB, row: BridgeRow, log: (level: "info" | "warn" | "error", m: string, e?: unknown) => void) {
  let cur = row;
  if (cur.status === "pending") {
    const confirmed = findConfirmedBridgeTxInChain(d, cur.blob_tx_id, cur.from_address, cur.amount);
    if (!confirmed) return;
    cur = upsertBridgeRow(d, { blob_tx_id: cur.blob_tx_id, status: "confirmed", confirmed_at: Date.now(), error: null });
  }
  if (cur.status !== "confirmed") return;

  // Atomic claim: confirmed → minting (only if still confirmed).
  const claim = d.db.prepare(`UPDATE bridge_requests SET status = 'minting' WHERE blob_tx_id = ? AND status = 'confirmed'`).run(cur.blob_tx_id);
  if (claim.changes === 0) return;
  log("info", `bridge minting ${cur.blob_tx_id}`, { sol_address: cur.sol_address, amount: cur.amount });
  try {
    const sig = await mintSpl(cur.sol_address, cur.amount);
    upsertBridgeRow(d, { blob_tx_id: cur.blob_tx_id, status: "minted", sol_signature: sig, minted_at: Date.now(), error: null });
    log("info", `bridge minted ${cur.blob_tx_id}`, { sig });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    upsertBridgeRow(d, { blob_tx_id: cur.blob_tx_id, status: "confirmed", error: msg });
    log("warn", `bridge mint failed ${cur.blob_tx_id}`, { err: msg });
  }
}

// ── Reverse: wBLOB → BLOB ──────────────────────────────────────────────
type RedeemRow = {
  sol_signature: string;
  blob_address: string;
  amount: number;
  credit_amount: number | null;
  bridge_fee: number | null;
  status: string;
  blob_tx_id: string | null;
  error: string | null;
  created_at: number;
  verified_at: number | null;
  credited_at: number | null;
};

export function getRedeemRow(d: DB, sig: string): RedeemRow | null {
  return d.db.prepare<[string], RedeemRow>(`SELECT * FROM bridge_redeems WHERE sol_signature = ?`).get(sig) ?? null;
}

function upsertRedeem(d: DB, r: Partial<RedeemRow> & { sol_signature: string }) {
  const ex = getRedeemRow(d, r.sol_signature);
  if (!ex) {
    d.db.prepare(`
      INSERT INTO bridge_redeems
        (sol_signature, blob_address, amount, credit_amount, bridge_fee, status, blob_tx_id, error, created_at, verified_at, credited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.sol_signature, r.blob_address!, r.amount!, r.credit_amount ?? null,
      r.bridge_fee ?? null, r.status ?? "pending", r.blob_tx_id ?? null,
      r.error ?? null, Date.now(), r.verified_at ?? null, r.credited_at ?? null,
    );
    return getRedeemRow(d, r.sol_signature)!;
  }
  d.db.prepare(`
    UPDATE bridge_redeems SET
      status = COALESCE(?, status),
      credit_amount = COALESCE(?, credit_amount),
      bridge_fee = COALESCE(?, bridge_fee),
      blob_tx_id = COALESCE(?, blob_tx_id),
      error = ?,
      verified_at = COALESCE(?, verified_at),
      credited_at = COALESCE(?, credited_at)
    WHERE sol_signature = ?
  `).run(
    r.status ?? null, r.credit_amount ?? null, r.bridge_fee ?? null,
    r.blob_tx_id ?? null, r.error ?? null,
    r.verified_at ?? null, r.credited_at ?? null, r.sol_signature,
  );
  return getRedeemRow(d, r.sol_signature)!;
}

export type RegisterRedeemInput = {
  sol_signature: string;
  blob_address: string;
  amount: number;
};

export function registerRedeem(d: DB, body: RegisterRedeemInput): { ok: boolean; row?: RedeemRow; error?: string } {
  const { sol_signature, blob_address, amount } = body;
  if (!SIG_RE.test(sol_signature)) return { ok: false, error: "invalid sol_signature" };
  if (!BLOB_ADDR_RE.test(blob_address)) return { ok: false, error: "invalid blob_address" };
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return { ok: false, error: "invalid amount" };
  const row = upsertRedeem(d, { sol_signature, blob_address, amount: amt, status: "pending" });
  return { ok: true, row };
}

export async function processReverseOnce(d: DB, log: (level: "info" | "warn" | "error", m: string, e?: unknown) => void) {
  if (!bridgeEnabled()) return;
  const rows = d.db.prepare<[], RedeemRow>(
    `SELECT * FROM bridge_redeems WHERE status IN ('pending','verified') ORDER BY created_at ASC LIMIT 20`,
  ).all();
  for (const row of rows) {
    try { await advanceReverse(d, row, log); }
    catch (e) { log("error", `bridge-redeem advance ${row.sol_signature}`, { err: String((e as Error)?.message ?? e) }); }
  }
}

async function advanceReverse(d: DB, row: RedeemRow, log: (level: "info" | "warn" | "error", m: string, e?: unknown) => void) {
  let cur = row;
  if (cur.status === "pending") {
    const v = await verifyBurn(cur.sol_signature, cur.amount, cur.blob_address);
    if (!v.ok) {
      if (/not finalized yet/i.test(v.reason)) return;
      upsertRedeem(d, { sol_signature: cur.sol_signature, status: "failed", error: v.reason });
      return;
    }
    const credit = Math.round((cur.amount - BRIDGE_FEE_BLOB) * BLOB_UNIT) / BLOB_UNIT;
    if (credit <= 0) {
      upsertRedeem(d, { sol_signature: cur.sol_signature, status: "failed", error: `amount below bridge fee (${BRIDGE_FEE_BLOB} BLOB)` });
      return;
    }
    cur = upsertRedeem(d, {
      sol_signature: cur.sol_signature,
      status: "verified",
      credit_amount: credit,
      bridge_fee: BRIDGE_FEE_BLOB,
      verified_at: Date.now(),
    });
  }
  if (cur.status !== "verified") return;

  const claim = d.db.prepare(`UPDATE bridge_redeems SET status = 'crediting' WHERE sol_signature = ? AND status = 'verified'`).run(cur.sol_signature);
  if (claim.changes === 0) return;

  const credit = Number(cur.credit_amount ?? 0);
  const r = signAndIngestCredit(d, cur.blob_address, credit, cur.sol_signature);
  if (!r.ok) {
    upsertRedeem(d, { sol_signature: cur.sol_signature, status: "verified", error: r.error?.slice(0, 500) ?? "credit failed" });
    return;
  }
  upsertRedeem(d, {
    sol_signature: cur.sol_signature,
    status: "credited", blob_tx_id: r.tx_id!,
    credited_at: Date.now(), error: null,
  });
  log("info", `bridge credited ${cur.sol_signature.slice(0, 12)}…`, { tx_id: r.tx_id, credit });
}

// ── BLOB tx signing for credit (sync, in-process) ──────────────────────
const enc = new TextEncoder();

function signAndIngestCredit(d: DB, blobAddress: string, creditAmount: number, solSig: string): { ok: boolean; tx_id?: string; error?: string } {
  const privBytes = hexToBytes(BRIDGE_BLOB_PRIVATE_KEY.replace(/^0x/, ""));
  const pubBytes = secp.getPublicKey(privBytes, true);
  const pubHex = bytesToHex(pubBytes);
  const derivedAddr = pubKeyToAddress(pubHex);
  if (derivedAddr !== BRIDGE_ADDRESS) {
    return { ok: false, error: `BRIDGE_BLOB_PRIVATE_KEY derives ${derivedAddr}, expected ${BRIDGE_ADDRESS}` };
  }

  const feeRate = Math.max(10, recommendedFeeRate(d));
  const ts = Date.now();
  const memo = `redeem:${solSig.slice(0, 16)}`;
  const amt = Math.round(creditAmount * BLOB_UNIT) / BLOB_UNIT;

  const data = `${BRIDGE_ADDRESS}→${blobAddress}:${amt}@${ts}|fr=${feeRate}|m=${memo}`;
  const msgHash = sha256(enc.encode(data));
  // sync sign (noble v2 supports sync via hashes injection — but to keep things
  // simple use signAsync via a deasync wrapper? No — use the sync API: secp.sign
  // requires hmac. We provide it.
  const sigBytes = signSyncWithHmac(msgHash, privBytes);
  const signature = bytesToHex(sigBytes);

  const txid = sha256hex(`${BRIDGE_ADDRESS}${blobAddress}${amt}${ts}${feeRate}${memo}`).slice(0, 40);

  const r = ingestTx(d, {
    id: txid, from: BRIDGE_ADDRESS, to: blobAddress, amount: amt,
    feeRate, memo, signature, publicKey: pubHex, timestamp: ts,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, tx_id: txid };
}

// noble v2 needs an HMAC-SHA256 implementation injected for sync signing.
import { hmac } from "@noble/hashes/hmac";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
(secp as any).etc = (secp as any).etc ?? {};
(secp as any).etc.hmacSha256Sync = (k: Uint8Array, ...m: Uint8Array[]) => hmac(nobleSha256, k, concatU8(...m));

function concatU8(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function signSyncWithHmac(msgHash: Uint8Array, priv: Uint8Array): Uint8Array {
  // secp.sign(msgHash, priv) returns Signature object with toCompactRawBytes().
  const sig = secp.sign(msgHash, priv);
  return sig.toCompactRawBytes();
}

// ── Solana JSON-RPC helpers ────────────────────────────────────────────
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${method} http ${r.status}`);
  const j: any = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result as T;
}

type VerifyResult = { ok: true; payer: string } | { ok: false; reason: string };

async function verifyBurn(sig: string, expectedAmount: number, expectedBlobAddr: string): Promise<VerifyResult> {
  let tx: any;
  try {
    tx = await rpc("getTransaction", [
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
    if (programId === TOKEN_PROGRAM_ID_STR && ix.parsed) {
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

// ── SPL mint (raw) ─────────────────────────────────────────────────────
const TOKEN_PROGRAM_ID = bs58.decode(TOKEN_PROGRAM_ID_STR);
const ASSOCIATED_TOKEN_PROGRAM_ID = bs58.decode(ASSOCIATED_TOKEN_PROGRAM_ID_STR);
const SYSTEM_PROGRAM_ID = new Uint8Array(32);

function isOnCurve(pub: Uint8Array): boolean {
  try { (ed as any).ExtendedPoint.fromHex(pub); return true; }
  catch { return false; }
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
  return findProgramAddress([owner, TOKEN_PROGRAM_ID, mint], ASSOCIATED_TOKEN_PROGRAM_ID).address;
}
function encodeShortVec(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  while (true) {
    let b = v & 0x7f; v >>>= 7;
    if (v === 0) { out.push(b); break; }
    b |= 0x80; out.push(b);
  }
  return new Uint8Array(out);
}
function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

type AccountMeta = { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean };
type Instruction = { programId: Uint8Array; keys: AccountMeta[]; data: Uint8Array };

function buildMessage(feePayer: Uint8Array, recentBlockhash: Uint8Array, instructions: Instruction[]) {
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
  const fpKey = key(feePayer);
  all.sort((a, b) => {
    if (key(a.pubkey) === fpKey) return -1;
    if (key(b.pubkey) === fpKey) return 1;
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
    compiled.push(concatU8(
      new Uint8Array([programIdIndex]),
      encodeShortVec(accountIndices.length),
      accountIndices,
      encodeShortVec(ix.data.length),
      ix.data,
    ));
  }
  const header = new Uint8Array([numSigners, numReadonlySigners, numReadonlyNonSigners]);
  const keysBlob = concatU8(encodeShortVec(accountKeys.length), ...accountKeys);
  const ixBlob = concatU8(encodeShortVec(compiled.length), ...compiled);
  const message = concatU8(header, keysBlob, recentBlockhash, ixBlob);
  return { message, accountKeys };
}

async function mintSpl(recipient: string, amount: number): Promise<string> {
  const raw = SOLANA_MINT_AUTHORITY.trim();
  let secretKey: Uint8Array;
  if (raw.startsWith("[")) secretKey = Uint8Array.from(JSON.parse(raw));
  else secretKey = bs58.decode(raw);
  if (secretKey.length !== 64) throw new Error("authority secret key must be 64 bytes");
  const privKey = secretKey.slice(0, 32);
  const authorityPub = secretKey.slice(32, 64);

  const mintPub = bs58.decode(SOLANA_SPL_MINT_ADDRESS);
  const recipientPub = bs58.decode(recipient);
  if (mintPub.length !== 32 || recipientPub.length !== 32) throw new Error("invalid pubkey length");

  const mintAcct = await rpc<any>("getAccountInfo", [
    SOLANA_SPL_MINT_ADDRESS,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (!mintAcct?.value?.data?.[0]) throw new Error("mint account not found");
  const mintData = Uint8Array.from(atob(mintAcct.value.data[0]), c => c.charCodeAt(0));
  const decimals = mintData[44];
  const baseUnits = BigInt(Math.round(amount * 10 ** decimals));
  if (baseUnits <= 0n) throw new Error("amount rounds to zero base units");

  const ata = getATA(recipientPub, mintPub);

  const createAtaIx: Instruction = {
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: authorityPub, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: recipientPub, isSigner: false, isWritable: false },
      { pubkey: mintPub, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]),
  };
  const mintToIx: Instruction = {
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mintPub, isSigner: false, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: authorityPub, isSigner: true, isWritable: false },
    ],
    data: concatU8(new Uint8Array([7]), u64le(baseUnits)),
  };

  const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "finalized" }]);
  const recentBlockhash = bs58.decode(bh.value.blockhash);

  const { message } = buildMessage(authorityPub, recentBlockhash, [createAtaIx, mintToIx]);
  const signature = await ed.signAsync(message, privKey);

  const wire = concatU8(encodeShortVec(1), signature, message);
  const wireB64 = Buffer.from(wire).toString("base64");

  const sigStr = await rpc<string>("sendTransaction", [
    wireB64,
    { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 5 },
  ]);

  // Poll for confirmation up to ~30s.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const st = await rpc<any>("getSignatureStatuses", [[sigStr], { searchTransactionHistory: false }]);
    const s = st?.value?.[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      if (s.err) throw new Error(`tx failed on-chain: ${JSON.stringify(s.err)}`);
      return sigStr;
    }
  }
  return sigStr; // unconfirmed but submitted; caller can poll
}

// ── Public lookup helpers ──────────────────────────────────────────────
export function getMintRow(d: DB, txId: string): BridgeRow | null { return getBridgeRow(d, txId); }
