// Single chokepoint for "stuff arriving from outside this node":
//   • txs and entries from local clients (wallets) over WS
//   • txs, entries, AND full blocks from peer nodes over WS
//
// All three pathways funnel through these pure functions so the rules can't
// drift between the client-handler code path and the peer-handler code path.
//
// `ingestBlock` is the new piece for Phase 3 — it validates a block produced
// by a peer (or a competing local seal) and atomically applies it, including a
// depth-1 reorg when both nodes sealed the same height ~simultaneously.

import type { DB } from "./db.js";
import { rowToTx } from "./db.js";
import {
  validateTx, validateEntry,
} from "./validate.js";
import {
  BLOCK_TIME_SECONDS, GENESIS_HASH, GENESIS_TIME_MS, MAX_BLOCK_SIZE, MAX_SUPPLY,
  computeBlockHash, getRewardForHeight, pickWinner, seedForHeight, to8,
  currentHeight,
} from "./consensus.js";
import type { Block, Tx, SubmitTxPayload, SubmitEntryPayload } from "../wsProtocol.js";

export type IngestTxResult =
  | { ok: true; isNew: boolean; tx: Tx; bytes: number }
  | { ok: false; error: string };

export type IngestEntryResult =
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

// ── ENTRY ───────────────────────────────────────────────────────────────
export function ingestEntry(d: DB, payload: SubmitEntryPayload): IngestEntryResult {
  const r = validateEntry(d, payload);
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

// ── BLOCK (peer or self) ────────────────────────────────────────────────
//
// Two paths through this function:
//   1. height = tip + 1 → straightforward append after full validation
//   2. height = tip     → potential reorg vs. our just-sealed tip; keep the
//                         block with the lexicographically smaller hash.
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
  const expectedPrev = isReplace
    ? (d.stmts.getBlockByHeight.get(block.height - 1)?.previous_hash !== undefined
        ? d.stmts.getBlockByHeight.get(block.height - 1)?.hash ?? GENESIS_HASH
        : GENESIS_HASH)
    : tipHash;
  if (block.previousHash !== expectedPrev) {
    return { ok: false, error: "bad prev", needsResync: true };
  }

  const expectedSeed = String(seedForHeight(block.height));
  if (block.seed !== expectedSeed) return { ok: false, error: "bad seed" };

  // Compare timestamp against the *prev* block of this candidate, not our tip.
  const prevTsForCandidate = isReplace
    ? (d.stmts.getBlockByHeight.get(block.height - 1)?.timestamp ?? GENESIS_TIME_MS)
    : tipTs;
  if (block.timestamp < prevTsForCandidate + BLOCK_TIME_SECONDS * 1000) {
    return { ok: false, error: "block too soon" };
  }
  if (block.timestamp > Date.now() + 60_000) {
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
    ? (d.stmts.getBlockByHeight.get(block.height - 1)?.total_supply ?? 0)
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
    // Tie-break: lexicographically smaller hash wins.
    if (existingByHeight && existingByHeight.hash <= block.hash) {
      return { ok: false, error: "lost tie-break" };
    }
    const apply = d.db.transaction(() => {
      // Restore losing block's txs to the mempool.
      if (existingByHeight) {
        let oldTxs: Tx[] = [];
        try { oldTxs = JSON.parse(existingByHeight.transactions); } catch { /* ignore */ }
        for (const t of oldTxs) {
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
      for (const t of block.transactions) d.stmts.deleteTxs.run(t.id);
    });
    apply();
    return { ok: true, applied: "replaced" };
  }

  // ── Append path ───────────────────────────────────────────────────────
  const apply = d.db.transaction(() => {
    d.stmts.insertBlock.run(blockToRow(block));
    for (const t of block.transactions) d.stmts.deleteTxs.run(t.id);
  });
  apply();
  return { ok: true, applied: "appended" };
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
