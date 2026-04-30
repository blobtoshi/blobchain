// Single chokepoint for "stuff arriving from outside this node":
//   • txs and entries from local clients (wallets) over WS
//   • txs, entries, AND full blocks from peer nodes over WS
//
// All pathways funnel through these pure functions so the rules can't drift
// between the client-handler code path and the peer-handler code path.

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
import type {
  Block, Tx, SubmitTxPayload,
  SubmitEntryCommitPayload, SubmitEntryRevealPayload,
} from "../wsProtocol.js";

export type IngestTxResult =
  | { ok: true; isNew: boolean; tx: Tx; bytes: number }
  | { ok: false; error: string };

export type IngestCommitResult =
  | { ok: true; address: string; block_height: number }
  | { ok: false; error: string };

export type IngestEntryResult =
  | { ok: true; isNewBest: boolean; address: string; score: number; block_height: number; block_seed: string; signature: string }
  | { ok: false; error: string };

export type IngestRevealResult =
  | { ok: true; isNewBest: boolean; address: string; score: number; block_height: number; block_seed: string; signature: string }
  | { ok: false; error: string };

export type IngestBlockResult =
  | { ok: true; applied: "appended" | "replaced" | "duplicate" }
  | { ok: false; error: string; needsResync?: boolean };

// ── TX ──────────────────────────────────────────────────────────────────
export function ingestTx(d: DB, payload: SubmitTxPayload): IngestTxResult {
  const r = validateTx(d, payload);
  if (!r.ok) return { ok: false, error: r.error };
  const t = r.value;
  const info = d.stmts.insertTx.run({
    id: t.id, from_address: t.from, to_address: t.to,
    amount: t.amount, fee: t.fee, fee_rate: t.feeRate,
    memo: t.memo || null, signature: t.signature, public_key: t.publicKey,
    timestamp: t.timestamp,
  });
  const isNew = info.changes > 0;
  return {
    ok: true,
    isNew,
    bytes: t.bytes,
    tx: {
      id: t.id, from: t.from, to: t.to, amount: t.amount, fee: t.fee,
      feeRate: t.feeRate, memo: t.memo, signature: t.signature,
      publicKey: t.publicKey, timestamp: t.timestamp,
    },
  };
}

// ── ENTRY COMMIT ────────────────────────────────────────────────────────
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
    address: c.address, public_key: c.publicKey, last_active: Date.now(),
  });
  return { ok: true, address: c.address, block_height: c.block_height };
}

// ── ENTRY REVEAL ────────────────────────────────────────────────────────
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
    address: e.address, public_key: e.publicKey, last_active: Date.now(),
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

// ── ENTRY (peer gossip — already validated by originating node) ─────────────
export function ingestEntry(d: DB, payload: {
  address: string; score: number;
  block_height: number; block_seed: string;
  signature: string; publicKey: string;
  inputs: unknown; inputs_hash: string;
  frame_count: number; engine_version: number;
}): IngestEntryResult {
  if (!payload.address || typeof payload.score !== "number") {
    return { ok: false, error: "invalid entry payload" };
  }
  const existing = d.stmts.getExistingEntry.get(payload.address, payload.block_height);
  if (existing && existing.score >= payload.score) {
    return {
      ok: true, isNewBest: false,
      address: payload.address, score: existing.score,
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
    ok: true, isNewBest: true,
    address: payload.address, score: payload.score,
    block_height: payload.block_height,
    block_seed: payload.block_seed,
    signature: payload.signature,
  };
}

// ── BLOCK (peer or self) ────────────────────────────────────────────────
//
// Two paths through this function:
//   1. height = tip + 1 → straightforward append after full validation
//   2. height = tip     → potential reorg vs. our just-sealed tip; keep the
//                         block whose deterministic tieBreakKey is smaller.
//                         Anything deeper than 1 is rejected with
//                         needsResync=true so the peer manager triggers a
//                         range pull.

export function ingestBlock(d: DB, block: Block): IngestBlockResult {
  if (!block || typeof block !== "object") return { ok: false, error: "invalid block" };

  // Cheap structural checks before we touch the DB.
  if (typeof block.height !== "number" || block.height < 1) return { ok: false, error: "bad height" };
  if (typeof block.hash !== "string" || block.hash.length < 16) return { ok: false, error: "bad hash" };
  if (typeof block.previousHash !== "string") return { ok: false, error: "bad prev" };
  if (!Array.isArray(block.transactions)) return { ok: false, error: "bad txs" };
  if (!Array.isArray(block.miningEntries)) return { ok: false, error: "bad entries" };
  if (typeof block.timestamp !== "number") return { ok: false, error: "bad ts" };

  const tip = d.stmts.getTip.get();
  const tipHeight = tip?.height ?? 0;
  const tipHash = tip?.hash ?? GENESIS_HASH;
  const tipTs = tip?.timestamp ?? GENESIS_TIME_MS;

  // Already have it (by hash)?
  const existingByHeight = d.stmts.getBlockByHeight.get(block.height);
  if (existingByHeight && existingByHeight.hash === block.hash) {
    return { ok: true, applied: "duplicate" };
  }

  // Anything more than one block past us is a deep reorg — out of scope.
  if (block.height > tipHeight + 1) return { ok: false, error: "ahead of tip", needsResync: true };
  if (block.height < tipHeight) return { ok: false, error: "below tip" };

  // Validate consensus invariants. Same checks the sealer applies before insert.
  const isReplace = block.height === tipHeight; // reorg candidate
  const prevBlockRow = isReplace
    ? d.stmts.getBlockByHeight.get(block.height - 1)
    : null;
  const expectedPrev = isReplace
    ? (prevBlockRow?.hash ?? GENESIS_HASH)
    : tipHash;
  if (block.previousHash !== expectedPrev) {
    return { ok: false, error: "bad prev", needsResync: true };
  }

  const expectedSeed = String(runtimeSeedForHeight(block.height, expectedPrev));
  if (block.seed !== expectedSeed) return { ok: false, error: "bad seed" };

  // Compare timestamp against the *prev* block of this candidate, not our tip.
  const prevTsForCandidate = isReplace
    ? (prevBlockRow?.timestamp ?? GENESIS_TIME_MS)
    : tipTs;
  // Tightened: allow at most BLOCK_PAST_TOLERANCE_MS of clock drift below the
  // canonical block-spacing minimum.
  if (block.timestamp < prevTsForCandidate + BLOCK_TIME_SECONDS * 1000 - BLOCK_PAST_TOLERANCE_MS) {
    return { ok: false, error: "block too soon" };
  }
  if (block.timestamp > Date.now() + BLOCK_FUTURE_TOLERANCE_MS) {
    return { ok: false, error: "block from the future" };
  }

  // Wall-clock guard: don't accept blocks for heights that haven't opened yet.
  const wall = currentHeight();
  if (block.height > wall) return { ok: false, error: "block height not yet open" };

  // Re-derive the winner from the entries the proposer included.
  const entriesForSelection = block.miningEntries.map((e) => ({
    address: String(e.address ?? ""),
    score: Number(e.score ?? 0),
    signature: String(e.signature ?? ""),
  }));
  const seedNum = Number(expectedSeed);
  const expectedWinner = pickWinner(entriesForSelection, seedNum);

  if (entriesForSelection.length === 0) {
    if (block.winner !== null) return { ok: false, error: "winner without entries" };
  } else {
    if (!expectedWinner) return { ok: false, error: "winner derivation failed" };
    if (block.winner !== expectedWinner.address) return { ok: false, error: "wrong winner" };
    if (Number(block.winnerScore) !== Number(expectedWinner.score)) return { ok: false, error: "wrong winner score" };
  }

  // Reward = (capped coinbase) + sum(tx.fee). Block size cap.
  let txBytesUsed = 10_000;
  let feeTotal = 0;
  for (const t of block.transactions) {
    const sz = JSON.stringify(t).length;
    txBytesUsed += sz;
    feeTotal += Number((t as Tx).fee ?? 0);
  }
  if (txBytesUsed > MAX_BLOCK_SIZE) return { ok: false, error: "block too large" };

  const baseReward = getRewardForHeight(block.height);
  const prevSupply = isReplace
    ? (prevBlockRow?.total_supply ?? 0)
    : (tip?.total_supply ?? 0);
  const remainingIssuance = Math.max(0, MAX_SUPPLY - prevSupply);
  const expectedCoinbase = expectedWinner ? Math.min(baseReward, remainingIssuance) : 0;
  const expectedReward = expectedWinner ? to8(expectedCoinbase + feeTotal) : 0;
  if (to8(Number(block.reward)) !== expectedReward) {
    return { ok: false, error: `bad reward (expected ${expectedReward}, got ${block.reward})` };
  }
  const expectedSupply = to8(prevSupply + expectedCoinbase);
  if (to8(Number(block.totalSupply ?? 0)) !== expectedSupply) {
    return { ok: false, error: "bad totalSupply" };
  }

  // Hash check.
  const computed = computeBlockHash({
    height: block.height,
    previousHash: block.previousHash,
    timestamp: block.timestamp,
    winner: block.winner ?? null,
    winnerScore: Number(block.winnerScore ?? 0),
    reward: Number(block.reward ?? 0),
    seed: block.seed,
    txCount: block.transactions.length,
  });
  if (computed !== block.hash) return { ok: false, error: "hash mismatch" };

  // ── Reorg path: same height as tip, different hash ────────────────────
  if (isReplace) {
    if (existingByHeight && existingByHeight.hash === block.hash) {
      return { ok: true, applied: "duplicate" };
    }
    // Deterministic, unforgeable tie-break: lower sha256(block||prev||seedHeight) wins.
    if (existingByHeight) {
      const incomingKey = tieBreakKey(block.hash, block.previousHash, block.height);
      const haveKey = tieBreakKey(existingByHeight.hash, existingByHeight.previous_hash, existingByHeight.height);
      if (haveKey <= incomingKey) return { ok: false, error: "lost tie-break" };
    }
    const apply = d.db.transaction(() => {
      // Restore losing block's txs to the mempool AND undo its balance effects.
      if (existingByHeight) {
        if (existingByHeight.winner) {
          applyBalanceDelta(d, existingByHeight.winner, -Number(existingByHeight.reward ?? 0));
        }
        let oldTxs: Tx[] = [];
        try { oldTxs = JSON.parse(existingByHeight.transactions); } catch { /* ignore */ }
        for (const t of oldTxs) {
          if (t.to)   applyBalanceDelta(d, t.to,   -Number(t.amount));
          if (t.from) applyBalanceDelta(d, t.from,  Number(t.amount) + Number(t.fee ?? 0));
          d.stmts.insertTx.run({
            id: t.id, from_address: t.from, to_address: t.to,
            amount: t.amount, fee: t.fee, fee_rate: t.feeRate,
            memo: t.memo || null, signature: t.signature, public_key: t.publicKey,
            timestamp: t.timestamp,
          });
        }
        d.db.prepare(`DELETE FROM blocks WHERE height = ?`).run(block.height);
      }
      d.stmts.insertBlock.run(blockToRow(block));
      applyBlockBalances(d, block);
      for (const t of block.transactions) d.stmts.deleteTxs.run(t.id);
    });
    apply();
    return { ok: true, applied: "replaced" };
  }

  // ── Append path ───────────────────────────────────────────────────────
  const apply = d.db.transaction(() => {
    d.stmts.insertBlock.run(blockToRow(block));
    applyBlockBalances(d, block);
    for (const t of block.transactions) d.stmts.deleteTxs.run(t.id);
    // Garbage-collect commits older than the new tip — they can no longer
    // be revealed against. Keep one window of slack for late peers.
    d.stmts.deleteOldCommits.run(block.height - 1);
  });
  apply();
  return { ok: true, applied: "appended" };
}

function applyBlockBalances(d: DB, block: Block) {
  if (block.winner) applyBalanceDelta(d, block.winner, Number(block.reward ?? 0));
  for (const t of block.transactions) {
    if (t.to)   applyBalanceDelta(d, t.to,   Number(t.amount));
    if (t.from) applyBalanceDelta(d, t.from, -(Number(t.amount) + Number(t.fee ?? 0)));
  }
}

function blockToRow(block: Block) {
  return {
    height: block.height,
    previous_hash: block.previousHash,
    timestamp: block.timestamp,
    transactions: JSON.stringify(block.transactions),
    mining_entries: JSON.stringify(block.miningEntries),
    winner: block.winner,
    winner_score: Number(block.winnerScore ?? 0),
    reward: Number(block.reward ?? 0),
    seed: block.seed,
    hash: block.hash,
    total_supply: Number(block.totalSupply ?? 0),
    node_count: Number(block.nodeCount ?? 1),
  };
}
