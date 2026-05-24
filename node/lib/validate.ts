// Validates incoming transactions and mining-entry commits/reveals.

// Mirrors the rules implemented in `submit-tx` so a tx that would have been

// accepted by Supabase is also accepted here, and vice-versa.



import { pubKeyToAddress, verifySig, sha256hex } from "./crypto.js";

import {

  ENGINE_VERSION, MAX_FRAMES, parseCanonicalInputs,

  plausibilityCheck, simulate,

} from "./simulator.js";

import {

  BLOB_UNIT, BLOCK_TIME_SECONDS, GENESIS_TIME_MS, MAX_BLOCK_SIZE, MAX_TX_SIZE, currentHeight,

  ENTRY_POW_BITS, ENTRY_REVEAL_WINDOW_SECONDS,

  GENESIS_HASH, runtimeSeedForHeight, verifyEntryPow,

  windowOpenMsForHeight, windowCloseMsForHeight,

} from "./consensus.js";

import type { DB } from "./db.js";

import { rowToBlock, rowToTx } from "./db.js";

import type {

  SubmitTxPayload, SubmitEntryPayload,

  SubmitEntryCommitPayload, SubmitEntryRevealPayload,

} from "../wsProtocol.js";



const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;

const PUB_RE = /^(02|03)[0-9a-fA-F]{64}$/;

const SIG_RE = /^[0-9a-fA-F]{128}$/;

const ID_RE = /^[0-9a-fA-F]{8,64}$/;

const HASH_RE = /^[0-9a-fA-F]{64}$/;

const SEED_RE = /^[0-9]+$/;

const SALT_RE = /^[0-9a-fA-F]{32}$/;

const NONCE_RE = /^[0-9a-fA-F]{1,32}$/;

const MEMO_RE = /^[\x20-\x7E\u00A0-\uFFFF\n\t]*$/;



const BASE_FEE_RATE = 10;

const MIN_FEE_RATE = 1;

const MAX_FEE_RATE = 10_000;

const MAX_MEMO_BYTES = 80;

const MAX_INPUTS_STR = MAX_FRAMES * 10;



const enc = new TextEncoder();



// -- Fees ----------------------------------------------------------------

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



// -- Balance (now O(1) via materialized index) ---------------------------

function calcBalance(d: DB, address: string): number {

  const row = d.stmts.getBalance.get(address);

  let bal = Number(row?.balance ?? 0);

  for (const p of d.stmts.getMempoolForAddress.all(address)) {

    bal -= Number(p.amount) + Number(p.fee ?? 0);

  }

  return Math.max(0, bal);

}



// -- Tx validation -------------------------------------------------------

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



  const payload = `${from}->${to}:${amt}@${ts}|fr=${feeRate}|m=${memo}`;

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



// -- Helpers -------------------------------------------------------------

function expectedRuntimeSeed(d: DB, block_height: number): string {

  const prev = d.stmts.getBlockByHeight.get(block_height - 1);

  const prevHash = prev?.hash ?? (block_height === 1 ? null : GENESIS_HASH);

  return String(runtimeSeedForHeight(block_height, prevHash));

}



// -- Entry COMMIT validation ---------------------------------------------

export type ValidatedCommit = {

  address: string;

  block_height: number;

  commit_hash: string;

  pow_nonce: string;

  publicKey: string;

  signature: string;

};



export function validateEntryCommit(

  d: DB, body: SubmitEntryCommitPayload,

): ValidationResult<ValidatedCommit> {

  const {

    address, block_height, commit_hash, pow_nonce,

    publicKey, signature, engine_version,

  } = body ?? ({} as SubmitEntryCommitPayload);



  if (typeof address !== "string" || !ADDR_RE.test(address)) return err("invalid address");

  if (typeof publicKey !== "string" || !PUB_RE.test(publicKey)) return err("invalid publicKey");

  if (typeof signature !== "string" || !SIG_RE.test(signature)) return err("invalid signature");

  if (typeof block_height !== "number" || block_height < 1) return err("invalid block_height");

  if (typeof commit_hash !== "string" || !HASH_RE.test(commit_hash)) return err("invalid commit_hash");

  if (typeof pow_nonce !== "string" || !NONCE_RE.test(pow_nonce)) return err("invalid pow_nonce");

  if (engine_version !== ENGINE_VERSION) return err(`engine_version mismatch (expected ${ENGINE_VERSION})`);



  const tip = d.stmts.getTip.get();

  const activeHeight = (tip?.height ?? 0) + 1;

  const tHeight = currentHeight();

  if (block_height !== activeHeight) return err(`stale block_height (active is #${activeHeight})`);

  if (block_height > tHeight) return err("block not yet open");



  // Reject commits arriving inside the reveal window - only reveals are

  // accepted there. This is what makes copy-then-snipe unprofitable.

  //

  // Overdue grace period: if the block's wall window has closed but no entry

  // has landed yet, the chain has stalled (no winner to copy). We accept new

  // commits indefinitely until the first entry lands - at which point the

  // sealer immediately mints the block on its next 5s tick, closing the

  // snipe window. Without this, missing one window stalls the chain forever.

  const windowClose = windowCloseMsForHeight(block_height);

  const revealOpens = windowClose - ENTRY_REVEAL_WINDOW_SECONDS * 1000;

  const blockOverdue = Date.now() >= windowClose;

  const liveCount = d.stmts.getEntriesForHeight.all(block_height).length;

  const inOverdueGrace = blockOverdue && liveCount === 0;

  if (Date.now() >= revealOpens && !inOverdueGrace) {

    return err(`commit window closed (reveal phase began ${ENTRY_REVEAL_WINDOW_SECONDS}s before block close)`);

  }



  const derived = pubKeyToAddress(publicKey.toLowerCase());

  if (derived !== address) return err("address does not match publicKey");



  // PoW gate - bound to (height, address, commit_hash) so a nonce can't be

  // reused across heights / addresses / commits.

  if (!verifyEntryPow(block_height, address, commit_hash, pow_nonce, ENTRY_POW_BITS)) {

    return err(`proof-of-work too weak (need ${ENTRY_POW_BITS} leading zero bits)`);

  }



  const payload = `commit:${block_height}:${address}:${commit_hash}`;

  if (!verifySig(publicKey, signature, payload)) return err("bad signature");



  return ok({ address, block_height, commit_hash, pow_nonce, publicKey, signature });

}



// -- Entry REVEAL validation ---------------------------------------------

export type ValidatedReveal = {

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



export function validateEntryReveal(

  d: DB, body: SubmitEntryRevealPayload,

): ValidationResult<ValidatedReveal> {

  const {

    address, score, block_height, block_seed,

    signature, publicKey, frame_count, inputs, inputs_hash, salt, engine_version,

  } = body ?? ({} as SubmitEntryRevealPayload);



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

  if (typeof salt !== "string" || !SALT_RE.test(salt)) return err("invalid salt");

  if (engine_version !== ENGINE_VERSION) return err(`engine_version mismatch (expected ${ENGINE_VERSION})`);



  const derived = pubKeyToAddress(publicKey.toLowerCase());

  if (derived !== address) return err("address does not match publicKey");



  const tip = d.stmts.getTip.get();

  const activeHeight = (tip?.height ?? 0) + 1;

  const tHeight = currentHeight();

  if (block_height !== activeHeight) return err(`stale block_height (active is #${activeHeight})`);

  if (block_height > tHeight) return err("block not yet open");



  // Block_seed must be the runtime seed (derived from prev hash). This is

  // what blocks pre-computed solver output for a future height.

  const expSeed = expectedRuntimeSeed(d, block_height);

  if (block_seed !== expSeed) return err("block_seed does not match runtime seed for this height");



  // Must have a matching commit, sent before the reveal window opened.

  // Overdue grace: if the block has stalled with no entries, the commit may

  // have been accepted after the normal reveal-window cutoff (see commit

  // validation). In that case there's no rival reveal to copy from, so the

  // late-commit check is skipped.

  const commit = d.stmts.getCommit.get(address, block_height);

  if (!commit) return err("no prior commit for this (address, height)");

  const windowClose = windowCloseMsForHeight(block_height);

  const revealOpens = windowClose - ENTRY_REVEAL_WINDOW_SECONDS * 1000;

  const blockOverdue = Date.now() >= windowClose;

  const liveCount = d.stmts.getEntriesForHeight.all(block_height).length;

  const inOverdueGrace = blockOverdue && liveCount === 0;

  if (commit.received_at >= revealOpens && !inOverdueGrace) {

    return err("commit was received too late to reveal");

  }



  // Commit must bind exactly this (score, inputs_hash, salt).

  const expectedCommit = sha256hex(`${Math.floor(sc)}|${inputs_hash}|${salt}`);

  if (expectedCommit !== commit.commit_hash) return err("reveal does not match commit_hash");



  // inputs_hash must match the canonical inputs trace.

  const computedHash = sha256hex(inputs);

  if (computedHash !== inputs_hash) return err("inputs_hash does not match trace");



  const payload = `reveal:${block_height}:${address}:${Math.floor(sc)}:${inputs_hash}:${salt}`;

  if (!verifySig(publicKey, signature, payload)) return err("bad signature");



  // Deterministic replay against the runtime seed.

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



// -- Phase 6: single-shot entry validator -----------------------------------

// Combines what validateEntryCommit + validateEntryReveal did: PoW check,

// signature check, simulator replay, score match. The score is visible in

// the payload (no commit hash) - sniping is prevented purely by the

// commit-window cutoff: no submissions accepted in the last

// ENTRY_REVEAL_WINDOW_SECONDS of the block window.

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

  pow_nonce: string;

};



export function validateEntry(

  d: DB, body: SubmitEntryPayload,

): ValidationResult<ValidatedEntry> {

  const {

    address, block_height, block_seed, score,

    frame_count, inputs, inputs_hash, pow_nonce,

    publicKey, signature, engine_version,

  } = body ?? ({} as SubmitEntryPayload);



  // Type/shape gates - same as the legacy reveal validator.

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

  if (typeof pow_nonce !== "string" || pow_nonce.length === 0 || pow_nonce.length > 64) return err("invalid pow_nonce");

  if (engine_version !== ENGINE_VERSION) return err(`engine_version mismatch (expected ${ENGINE_VERSION})`);



  const derived = pubKeyToAddress(publicKey.toLowerCase());

  if (derived !== address) return err("address does not match publicKey");



  const tip = d.stmts.getTip.get();

  const activeHeight = (tip?.height ?? 0) + 1;

  const tHeight = currentHeight();

  if (block_height !== activeHeight) return err(`stale block_height (active is #${activeHeight})`);

  if (block_height > tHeight) return err("block not yet open");



  // Block_seed must match the runtime seed for this height. Stops anyone

  // from precomputing a high score against a future seed.

  const expSeed = expectedRuntimeSeed(d, block_height);

  if (block_seed !== expSeed) return err("block_seed does not match runtime seed for this height");



  // Window check: only accept submissions during the commit phase. After

  // the cutoff, no new entries - the reveal phase becomes a node-side

  // convergence window during which gossip propagates the final entry set.

  //

  // Window close is computed from the previous block's actual timestamp

  // (prev_ts + BLOCK_TIME_SECONDS), not from a genesis-fixed schedule. This

  // matches the frontend countdown so a player who sees "80s remaining"

  // has 80s of actual headroom. A chain that stalled or sealed late doesn't

  // permanently shift every future window into the past.

  //

  // Overdue grace: if the block is past its nominal close with zero entries,

  // accept submissions until the first one lands. Without this, a block

  // window that passes with no participants would stall the chain forever.

  const prevTs = tip?.timestamp ?? GENESIS_TIME_MS;

  const windowClose = prevTs + (BLOCK_TIME_SECONDS * 1000);

  const submitCutoff = windowClose - ENTRY_REVEAL_WINDOW_SECONDS * 1000;

  const blockOverdue = Date.now() >= windowClose;

  const liveCount = d.stmts.getEntriesForHeight.all(block_height).length;

  const inOverdueGrace = blockOverdue && liveCount === 0;

  if (Date.now() >= submitCutoff && !inOverdueGrace) {

    return err(`submission window closed (last ${ENTRY_REVEAL_WINDOW_SECONDS}s reserved for node convergence)`);

  }



  // inputs_hash binds the canonical inputs trace and is what the PoW

  // covers. A different trace would change the hash and invalidate the PoW.

  const computedHash = sha256hex(inputs);

  if (computedHash !== inputs_hash) return err("inputs_hash does not match trace");



  // PoW gate - bound to (height, address, inputs_hash). Without binding

  // to a specific play, the same nonce could be reused across submissions.

  if (!verifyEntryPow(block_height, address, inputs_hash, pow_nonce, ENTRY_POW_BITS)) {

    return err(`proof-of-work too weak (need ${ENTRY_POW_BITS} leading zero bits)`);

  }



  // Signature covers (height, address, score, inputs_hash). Score is

  // signed so the network has cryptographic proof of what the player

  // claimed - peers gossipping the entry can't change the score.

  const payload = `entry:${block_height}:${address}:${Math.floor(sc)}:${inputs_hash}`;

  if (!verifySig(publicKey, signature, payload)) return err("bad signature");



  // Deterministic replay - the actual proof that the score is real.

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



  // Bot-cadence detection. Real players exhibit reaction-time variance
  // in their input timing - even when "tapping rhythmically", they hit
  // different frame intervals (41, 44, 38, 47, 42 around a ~43-frame
  // target).
  //
  // Bots that fire inputs at fixed delays produce exact-frame intervals
  // with zero variance. v3 narrows the surface: jumps are one-shot, so
  // there are no jump-holds to fingerprint - we only check inter-jump
  // tempo, plus duck-hold duration and duck tempo.
  //
  // Flag rule: 5+ exact-matching values, comprising >=80% of the +-2
  // tolerance band around the mode. A real human can hit the same
  // value 2-3 times by luck; 5+ is implausibly tight.
  function checkCadence(intervals: number[], label: string): string | null {
    if (intervals.length < 5) return null;
    const counts = new Map<number, number>();
    for (const iv of intervals) counts.set(iv, (counts.get(iv) ?? 0) + 1);
    let modeIv = 0, modeCount = 0;
    for (const [iv, n] of counts) {
      if (n > modeCount) { modeCount = n; modeIv = iv; }
    }
    let bandCount = 0;
    for (const [iv, n] of counts) {
      if (Math.abs(iv - modeIv) <= 2) bandCount += n;
    }
    const exactShare = bandCount > 0 ? modeCount / bandCount : 0;
    if (modeCount >= 5 && exactShare >= 0.8) {
      return `mechanical input pattern detected (${modeCount} ${label} exactly ${modeIv} frames apart)`;
    }
    return null;
  }

  const typedEvents = events as { f: number; t: number }[];

  // Duck press->release HOLD durations (v3: jumps no longer have a release).
  const duckHolds: number[] = [];
  for (let i = 0; i < typedEvents.length - 1; i++) {
    const a = typedEvents[i];
    const b = typedEvents[i + 1];
    if (a.t === 2 && b.t === 3) duckHolds.push(b.f - a.f);
  }
  const duckHoldFlag = checkCadence(duckHolds, "duck holds");
  if (duckHoldFlag) return err(duckHoldFlag);

  // Press-press TEMPO intervals, per action.
  const jumpPresses: number[] = [];
  const duckPresses: number[] = [];
  for (const e of typedEvents) {
    if (e.t === 0) jumpPresses.push(e.f);
    if (e.t === 2) duckPresses.push(e.f);
  }
  const jumpTempo: number[] = [];
  for (let i = 1; i < jumpPresses.length; i++) jumpTempo.push(jumpPresses[i] - jumpPresses[i - 1]);
  const duckTempo: number[] = [];
  for (let i = 1; i < duckPresses.length; i++) duckTempo.push(duckPresses[i] - duckPresses[i - 1]);
  const jumpTempoFlag = checkCadence(jumpTempo, "jumps");
  if (jumpTempoFlag) return err(jumpTempoFlag);
  const duckTempoFlag = checkCadence(duckTempo, "ducks");
  if (duckTempoFlag) return err(duckTempoFlag);



  return ok({

    address, score: Math.floor(sc), block_height,

    block_seed, signature, publicKey,

    inputs, inputs_hash, frame_count, pow_nonce,

  });

}



// Re-export so full-node.ts can use them when packing blocks.

export { rowToBlock, rowToTx };
