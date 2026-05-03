// Single chokepoint for "stuff arriving from outside this node"

import type { DB } from "./db.js";
import { applyBalanceDelta } from "./db.js";
import {
  validateTx, validateEntryCommit, validateEntryReveal,
} from "./validate.js";
import {
  BLOCK_TIME_SECONDS, GENESIS_HASH, GENESIS_TIME_MS, MAX_BLOCK_SIZE, MAX_SUPPLY,
  computeBlockHash, getRewardForHeight, pickWinner, runtimeSeedForHeight, to8,
  currentHeight, tieBreakKey,
  BLOCK_FUTURE_TOLERANCE_MS, BLOCK_PAST_TOLERANCE_MS,
} from "./consensus.js";
import { scoreWeight } from "./lottery.js";
import type {
  Block, Tx, SubmitTxPayload,
  SubmitEntryCommitPayload, SubmitEntryRevealPayload,
} from "../wsProtocol.js";

/* ───────────────── TYPES ───────────────── */

export type IngestTxResult =
  | { ok: true; isNew: boolean; tx: Tx; bytes: number }
  | { ok: false; error: string };

export type IngestCommitResult =
  | { ok: true; address: string; block_height: number }
  | { ok: false; error: string };

export type IngestEntryResult =
  | { ok: true; isNewBest: boolean; address: string; score: number; block_height: number; block_seed: string; signature: string }
  | { ok: false; error: string };

export type IngestRevealResult = IngestEntryResult;

export type IngestBlockResult =
  | { ok: true; applied: "appended" | "replaced" | "duplicate" }
  | { ok: false; error: string; needsResync?: boolean };

/* ───────────────── TX ───────────────── */

export function ingestTx(d: DB, payload: SubmitTxPayload): IngestTxResult {
  const r = validateTx(d, payload);
  if (!r.ok) return { ok: false, error: r.error };

  const t = r.value;

  const info = d.stmts.insertTx.run({
    id: t.id,
    from_address: t.from,
    to_address: t.to,
    amount: t.amount,
    fee: t.fee,
    fee_rate: t.feeRate,
    memo: t.memo || null,
    signature: t.signature,
    public_key: t.publicKey,
    timestamp: t.timestamp,
  });

  return {
    ok: true,
    isNew: info.changes > 0,
    bytes: t.bytes,
    tx: t,
  };
}

/* ───────────────── ENTRY COMMIT ───────────────── */

export function ingestEntryCommit(d: DB, payload: SubmitEntryCommitPayload): IngestCommitResult {
  const r = validateEntryCommit(d, payload);
  if (!r.ok) return { ok: false, error: r.error };

  const c = r.value;

  d.stmts.insertCommit.run({
    address: c.address,
    block_height: c.block_height,
    commit_hash: c.commit_hash,
    pow_nonce: c.pow_nonce,
    public_key: c.publicKey,
    signature: c.signature,
    received_at: Date.now(),
  });

  d.stmts.upsertAddress.run({
    address: c.address,
    public_key: c.publicKey,
    last_active: Date.now(),
  });

  return { ok: true, address: c.address, block_height: c.block_height };
}

/* ───────────────── ENTRY REVEAL ───────────────── */

export function ingestEntryReveal(d: DB, payload: SubmitEntryRevealPayload): IngestRevealResult {
  const r = validateEntryReveal(d, payload);
  if (!r.ok) return { ok: false, error: r.error };

  const e = r.value;
  const existing = d.stmts.getExistingEntry.get(e.address, e.block_height);

  const finalScore = Math.max(e.score, existing?.score ?? 0);
  const isNewBest = finalScore === e.score && (!existing || e.score > existing.score);

  d.stmts.upsertEntry.run({
    address: e.address,
    block_height: e.block_height,
    score: finalScore,
    block_seed: e.block_seed,
    signature: e.signature,
    inputs: isNewBest ? e.inputs : null,
    inputs_hash: isNewBest ? e.inputs_hash : null,
    frame_count: isNewBest ? e.frame_count : null,
  });

  d.stmts.markCommitRevealed.run(e.address, e.block_height);

  d.stmts.upsertAddress.run({
    address: e.address,
    public_key: e.publicKey,
    last_active: Date.now(),
  });

  return {
    ok: true,
    isNewBest,
    address: e.address,
    score: finalScore,
    block_height: e.block_height,
    block_seed: e.block_seed,
    signature: e.signature,
  };
}

/* ───────────────── ENTRY (PEER) ───────────────── */

export function ingestEntry(d: DB, payload: any): IngestEntryResult {
  if (!payload.address || typeof payload.score !== "number") {
    return { ok: false, error: "invalid entry payload" };
  }

  const existing = d.stmts.getExistingEntry.get(payload.address, payload.block_height);

  if (existing && existing.score >= payload.score) {
    return {
      ok: true,
      isNewBest: false,
      address: payload.address,
      score: existing.score,
      block_height: payload.block_height,
      block_seed: payload.block_seed,
      signature: payload.signature,
    };
  }

  d.stmts.upsertEntry.run({
    address: payload.address,
    block_height: payload.block_height,
    score: payload.score,
    block_seed: payload.block_seed,
    signature: payload.signature,
    inputs: payload.inputs ? JSON.stringify(payload.inputs) : null,
    inputs_hash: payload.inputs_hash ?? null,
    frame_count: payload.frame_count ?? null,
  });

  return {
    ok: true,
    isNewBest: true,
    address: payload.address,
    score: payload.score,
    block_height: payload.block_height,
    block_seed: payload.block_seed,
    signature: payload.signature,
  };
}

/* ───────────────── BLOCK ───────────────── */

export function ingestBlock(d: DB, block: Block): IngestBlockResult {
  if (!block || typeof block !== "object") return { ok: false, error: "invalid block" };

  const tip = d.stmts.getTip.get();
  const tipHeight = tip?.height ?? 0;

  const existingByHeight = d.stmts.getBlockByHeight.get(block.height);
  if (existingByHeight && existingByHeight.hash === block.hash) {
    return { ok: true, applied: "duplicate" };
  }

  if (block.height > tipHeight + 1) return { ok: false, error: "ahead of tip", needsResync: true };
  if (block.height < tipHeight) return { ok: false, error: "below tip" };

  const isReplace = block.height === tipHeight;

  /* 🔥 NEW (MERGED) TIE-BREAK LOGIC */

  if (isReplace && existingByHeight) {
    const incomingW = scoreWeight(Number(block.winnerScore ?? 0));
    const haveW = scoreWeight(Number(existingByHeight.winner_score ?? 0));

    if (incomingW < haveW) {
      return { ok: false, error: "lost tie-break (lower winner weight)" };
    }

    if (incomingW === haveW) {
      const incomingKey = tieBreakKey(block.hash, block.previousHash, block.height);
      const haveKey = tieBreakKey(existingByHeight.hash, existingByHeight.previous_hash, existingByHeight.height);

      if (haveKey <= incomingKey) {
        return { ok: false, error: "lost tie-break" };
      }
    }
  }

  // (rest unchanged — omitted here for brevity, but you should keep your existing logic)

  return { ok: true, applied: isReplace ? "replaced" : "appended" };
}
