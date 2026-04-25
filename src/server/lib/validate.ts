// Validates incoming transactions and mining entries. Mirrors the rules
// implemented in `submit-tx` and `submit-entry` edge functions so a tx that
// would have been accepted by Supabase is also accepted here, and vice-versa.

import { pubKeyToAddress, verifySig, sha256hex } from "./crypto.js";
import {
  ENGINE_VERSION, MAX_FRAMES, parseCanonicalInputs,
  plausibilityCheck, simulate,
} from "./simulator.js";
import {
  BLOB_UNIT, MAX_BLOCK_SIZE, MAX_TX_SIZE, currentHeight,
} from "./consensus.js";
import type { DB } from "./db.js";
import { rowToBlock, rowToTx } from "./db.js";
import type { SubmitTxPayload, SubmitEntryPayload } from "../wsProtocol.js";

const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;
const SIG_RE = /^[0-9a-fA-F]{128}$/;
const ID_RE = /^[0-9a-fA-F]{8,64}$/;
const HASH_RE = /^[0-9a-fA-F]{64}$/;
const SEED_RE = /^[0-9]+$/;
const MEMO_RE = /^[\x20-\x7E\u00A0-\uFFFF\n\t]*$/;

const BASE_FEE_RATE = 10;
const MIN_FEE_RATE = 1;
const MAX_FEE_RATE = 10_000;
const MAX_MEMO_BYTES = 80;
const MAX_INPUTS_STR = MAX_FRAMES * 10;

const enc = new TextEncoder();

// ── Fees ────────────────────────────────────────────────────────────────
function canonicalTxBytes(tx: {
  from: string; to: string; amount: number; timestamp: number;
  feeRate: number; memo: string; publicKey: string; signature: string;
}): number {
  const canonical = JSON.stringify({
    from: tx.from, to: tx.to, amount: tx.amount, timestamp: tx.timestamp,
    feeRate: tx.feeRate, memo: tx.memo, publicKey: tx.publicKey, signature: tx.signature,
  });
  return enc.encode(canonical).length;
}

function feeFromRate(feeRate: number, bytes: number): number {
  return Math.ceil(feeRate * bytes) / BLOB_UNIT;
}

export function recommendedFeeRate(d: DB): number {
  const c = d.stmts.countMempool.get();
  const bytes = (c?.c ?? 0) * 600;
  const load = Math.min(bytes / MAX_BLOCK_SIZE, 10);
  const rec = Math.ceil(BASE_FEE_RATE * Math.pow(1 + load, 2));
  return Math.max(MIN_FEE_RATE, Math.min(rec, MAX_FEE_RATE));
}

export function feeInfo(d: DB) {
  return {
    recommendedFeeRate: recommendedFeeRate(d),
    minFeeRate: MIN_FEE_RATE,
    baseFeeRate: BASE_FEE_RATE,
  };
}

// ── Balance (full chain scan; fine for an MVP node) ─────────────────────
function calcBalance(d: DB, address: string): number {
  let bal = 0;
  const allBlocks = d.db.prepare<[], { winner: string | null; reward: number; transactions: string }>(
    `SELECT winner, reward, transactions FROM blocks ORDER BY height ASC`,
  ).all();
  for (const b of allBlocks) {
    if (b.winner === address) bal += Number(b.reward ?? 0);
    let txs: Array<{ from: string; to: string; amount: number; fee?: number }> = [];
    try { txs = JSON.parse(b.transactions); } catch { /* ignore */ }
    for (const tx of txs) {
      if (tx.to === address) bal += Number(tx.amount);
      if (tx.from === address) bal -= Number(tx.amount) + Number(tx.fee ?? 0);
    }
  }
  for (const p of d.stmts.getMempoolForAddress.all(address)) {
    bal -= Number(p.amount) + Number(p.fee ?? 0);
  }
  return Math.max(0, bal);
}

// ── Tx validation ───────────────────────────────────────────────────────
export type ValidatedTx = {
  id: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  feeRate: number;
  memo: string;
  signature: string;
  publicKey: string;
  timestamp: number;
  bytes: number;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateTx(d: DB, body: SubmitTxPayload): ValidationResult<ValidatedTx> {
  const {
    id, from, to, amount, signature, publicKey, timestamp,
    feeRate: feeRateRaw, memo: memoRaw,
  } = body ?? ({} as SubmitTxPayload);

  if (typeof id !== "string" || !ID_RE.test(id)) return err("invalid id");
  if (typeof from !== "string" || !ADDR_RE.test(from)) return err("invalid from");
  if (typeof to !== "string" || !ADDR_RE.test(to)) return err("invalid to");
  if (from === to) return err("self-send not allowed");
  if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return err("invalid publicKey");
  if (typeof signature !== "string" || !SIG_RE.test(signature)) return err("invalid signature");

  const amtRaw = Number(amount);
  if (!Number.isFinite(amtRaw) || amtRaw <= 0 || amtRaw > 1_000_000) return err("invalid amount");
  const units = Math.round(amtRaw * BLOB_UNIT);
  if (Math.abs(amtRaw * BLOB_UNIT - units) > 1e-6) return err("amount exceeds 8-decimal precision");
  const amt = units / BLOB_UNIT;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return err("invalid timestamp");
  if (Math.abs(Date.now() - ts) > 10 * 60 * 1000) return err("timestamp out of window");

  const memo = typeof memoRaw === "string" ? memoRaw : "";
  if (memo.length > 0 && !MEMO_RE.test(memo)) return err("memo contains invalid characters");
  if (enc.encode(memo).length > MAX_MEMO_BYTES) return err(`memo exceeds ${MAX_MEMO_BYTES} bytes`);

  const feeRate = Math.floor(Number(feeRateRaw));
  if (!Number.isFinite(feeRate) || feeRate < MIN_FEE_RATE || feeRate > MAX_FEE_RATE) {
    return err(`invalid feeRate (must be ${MIN_FEE_RATE}–${MAX_FEE_RATE} drops/byte)`);
  }

  const derived = pubKeyToAddress(publicKey.toLowerCase());
  if (derived !== from) return err("from does not match publicKey");

  const payload = `${from}→${to}:${amt}@${ts}|fr=${feeRate}|m=${memo}`;
  if (!verifySig(publicKey, signature, payload)) return err("bad signature");

  const recRate = recommendedFeeRate(d);
  const floorRate = Math.max(MIN_FEE_RATE, Math.floor(recRate * 0.5));
  if (feeRate < floorRate) {
    return err(`feeRate too low (network minimum ${floorRate} drops/byte, recommended ${recRate})`);
  }

  const bytes = canonicalTxBytes({
    from, to, amount: amt, timestamp: ts, feeRate, memo, publicKey, signature,
  });
  if (bytes > MAX_TX_SIZE) return err(`tx too large (max ${MAX_TX_SIZE} bytes)`);
  const fee = feeFromRate(feeRate, bytes);

  const bal = calcBalance(d, from);
  if (amt + fee > bal) return err(`insufficient balance (need ${(amt + fee).toFixed(8)})`);

  return ok({
    id, from, to, amount: amt, fee, feeRate, memo,
    signature, publicKey, timestamp: ts, bytes,
  });
}

// ── Entry validation ────────────────────────────────────────────────────
export type ValidatedEntry = {
  address: string;
  score: number;
  block_height: number;
  block_seed: string;
  signature: string;
  publicKey: string;
  inputs: string;
  inputs_hash: string;
  frame_count: number;
};

export function validateEntry(d: DB, body: SubmitEntryPayload): ValidationResult<ValidatedEntry> {
  const {
    address, score, block_height, block_seed,
    signature, publicKey, frame_count, inputs, inputs_hash, engine_version,
  } = body ?? ({} as SubmitEntryPayload);

  if (typeof address !== "string" || !ADDR_RE.test(address)) return err("invalid address");
  if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return err("invalid publicKey");
  if (typeof signature !== "string" || !SIG_RE.test(signature)) return err("invalid signature");
  if (typeof block_height !== "number" || block_height < 1) return err("invalid block_height");
  const sc = Number(score);
  if (!Number.isFinite(sc) || sc < 0 || sc > 10_000_000) return err("invalid score");
  if (typeof block_seed !== "string" || !SEED_RE.test(block_seed)) return err("invalid block_seed");
  if (typeof frame_count !== "number" || !Number.isInteger(frame_count)) return err("invalid frame_count");
  if (typeof inputs !== "string" || inputs.length > MAX_INPUTS_STR) return err("invalid inputs trace");
  if (typeof inputs_hash !== "string" || !HASH_RE.test(inputs_hash)) return err("invalid inputs_hash");
  if (engine_version !== ENGINE_VERSION) return err(`engine_version mismatch (expected ${ENGINE_VERSION})`);

  const derived = pubKeyToAddress(publicKey.toLowerCase());
  if (derived !== address) return err("address does not match publicKey");

  const tip = d.stmts.getTip.get();
  const activeHeight = (tip?.height ?? 0) + 1;
  const tHeight = currentHeight();
  if (block_height !== activeHeight) return err(`stale block_height (active is #${activeHeight})`);
  if (block_height > tHeight) return err("block not yet open");

  const computedHash = sha256hex(inputs);
  if (computedHash !== inputs_hash) return err("inputs_hash does not match trace");

  const payload = `${block_height}:${address}:${Math.floor(sc)}:${inputs_hash}`;
  if (!verifySig(publicKey, signature, payload)) return err("bad signature");

  const events = inputs.length === 0 ? [] : parseCanonicalInputs(inputs);
  const plaus = plausibilityCheck(events, frame_count, Math.floor(sc));
  if (plaus) return err(`replay rejected: ${plaus}`);

  const seedNum = Number(block_seed);
  if (!Number.isFinite(seedNum)) return err("seed not numeric");
  const result = simulate(seedNum, events, frame_count);
  if (!result.dead) return err("replay did not terminate (player still alive)");
  if (result.frame !== frame_count) return err(`frame_count mismatch (replay=${result.frame})`);
  if (result.score !== Math.floor(sc)) return err(`score mismatch (replay=${result.score})`);
  if (result.score === 0) return err("replay rejected: must clear first obstacle");

  return ok({
    address, score: Math.floor(sc), block_height,
    block_seed, signature, publicKey,
    inputs, inputs_hash, frame_count,
  });
}

function err<T>(error: string): ValidationResult<T> { return { ok: false, error }; }
function ok<T>(value: T): ValidationResult<T> { return { ok: true, value }; }

// Re-export so full-node.ts can use them when packing blocks.
export { rowToBlock, rowToTx };
