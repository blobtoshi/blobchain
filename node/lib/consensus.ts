// Consensus rules. These constants and functions MUST stay byte-for-byte in
// sync with `src/lib/blob/chain.ts`,
// otherwise full nodes will produce different block hashes than the rest of
// the network and fork the chain.

import { sha256hex } from "./crypto.js";
import { scoreWeight } from "./lottery.js";

export const BLOCK_TIME_SECONDS = 120;
export const INITIAL_REWARD = 10;
export const HALVING_BLOCKS = 1_000_000;
export const MAX_SUPPLY = 20_000_000;
export const GENESIS_TIME_MS = 1_777_517_348_838;
export const GENESIS_HASH =
  "412c22f77b50de1a3faec282597d49b58a04bb5161e6d414f9885ab09de24bc7";

export const MAX_BLOCK_SIZE = 1_000_000; // 1 MB
export const MAX_TX_SIZE = 100_000;      // 100 KB
export const BLOB_UNIT = 1e8;

// ── Anti-grinding / anti-spam parameters ───────────────────────────────
// Per-entry proof-of-work difficulty in leading zero bits of sha256.
// 18 bits ≈ 262k hashes ≈ ~0.5s on a laptop, ~1.5s on a low-end phone.
// An attacker spamming 10k sybil entries pays ~10k × that per height.
export const ENTRY_POW_BITS = 18;

// Reveal window: the last N seconds of a block window are reserved for
// reveals. Commits received during this window are rejected — this is what
// stops "snipe-then-copy" attacks on the entry mempool.
export const ENTRY_REVEAL_WINDOW_SECONDS = 30;

// Timestamp tolerances for incoming blocks (anti-grinding).
export const BLOCK_FUTURE_TOLERANCE_MS = 5_000;       // was 60_000
export const BLOCK_PAST_TOLERANCE_MS   = 2_000;       // small clock drift

// Re-export so other consensus call-sites can import everything from one place.
export { scoreWeight };

export const to8 = (n: number): number => Math.round(Number(n) * BLOB_UNIT) / BLOB_UNIT;

/** Mulberry32-style PRNG, matched to the edge function bit-for-bit. */
export function mkPrng(seed: number): () => number {
  let s = (Math.abs(+seed) * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getRewardForHeight(h: number): number {
  const halvings = Math.floor(h / HALVING_BLOCKS);
  return Math.min(INITIAL_REWARD / Math.pow(2, halvings), INITIAL_REWARD);
}

/** Wall-clock height = how many block windows have elapsed since genesis. */
export function currentHeight(): number {
  const now = Math.floor(Date.now() / 1000);
  const genesis = Math.floor(GENESIS_TIME_MS / 1000);
  return Math.floor(Math.max(0, now - genesis) / BLOCK_TIME_SECONDS) + 1;
}

/** Wall-clock open timestamp (ms) for the start of a block window. */
export function windowOpenMsForHeight(height: number): number {
  return GENESIS_TIME_MS + (height - 1) * BLOCK_TIME_SECONDS * 1000;
}

/** Wall-clock close timestamp (ms) for a block window. */
export function windowCloseMsForHeight(height: number): number {
  return windowOpenMsForHeight(height) + BLOCK_TIME_SECONDS * 1000;
}

/** Cosmetic, fully public seed (used for static metadata / cosmetic background). */
export function seedForHeight(height: number): number {
  // Use BigInt to avoid 53-bit float drift on the multiplication.
  const seedBig = BigInt(height) * 6364136223846793n + 1442695040888963407n;
  return Number(seedBig % 2147483647n < 0n
    ? -(seedBig % 2147483647n)
    : seedBig % 2147483647n);
}

/**
 * Runtime seed used to generate the actual obstacle layout for height H.
 *
 * Derived from `sha256(prevHash || ":" || H)` and folded into a 31-bit int.
 * Because `prevHash` is not known until block H-1 is sealed (~120s before
 * H closes), nobody can pre-compute the obstacle layout for future heights.
 *
 * Real-time bots that observe the canvas (or call `generateLevelPure`
 * the moment H-1 lands) are unaffected — we only block *pre-computation*.
 *
 * Genesis special case (H = 1): no prev block, so we fall back to
 * `seedForHeight(1)`. Same value the sealer uses; everyone agrees.
 */
export function runtimeSeedForHeight(height: number, prevHash: string | null | undefined): number {
  if (!prevHash || height <= 1) return seedForHeight(height);
  const hex = sha256hex(`${prevHash}:${height}`);
  // Take the high 8 hex chars (32 bits) and fold to a 31-bit non-negative int.
  const n = parseInt(hex.slice(0, 8), 16);
  return n & 0x7fffffff;
}

export type EntryForSelection = {
  address: string;
  score: number;
  signature: string;
};

/**
 * Weighted lottery winner selection. Sorted by address for determinism.
 *
 * Uses the shared `scoreWeight()` curve from ./lottery.js:
 *   • Entries with score ≥ 200 get weight = score^4
 *   • Entries with score < 200 get weight = (s/200)^8 × 1e-6 (effectively zero)
 *
 * MUST stay byte-for-byte in sync with src/lib/blob/chain.ts pickWinner.
 */
export function pickWinner<T extends EntryForSelection>(
  entries: T[],
  blockSeed: number,
): T | null {
  if (!entries?.length) return null;
  const sorted = [...entries].sort((a, b) => (a.address < b.address ? -1 : 1));
  const weighted = sorted.map(e => scoreWeight(Number(e.score || 0)));
  const total = weighted.reduce((s, w) => s + w, 0);
  if (total <= 0) return sorted[0] ?? null;
  const rng = mkPrng(blockSeed);
  let target = rng() * total;
  for (let i = 0; i < sorted.length; i++) {
    target -= weighted[i];
    if (target <= 0) return sorted[i];
  }
  return sorted[sorted.length - 1] ?? null;
}

// ── Content commitments (C1) ────────────────────────────────────────────
// The block hash must commit to the *contents* of the transactions and
// mining entries, not just their count. Otherwise two blocks carrying
// completely different payloads hash identically and the hash check provides
// no integrity over what gets applied to balances.
//
// canonicalTxLeaf / canonicalEntryLeaf and the root functions below MUST stay
// byte-for-byte in sync with src/lib/blob/chain.ts so the browser client and
// the full node agree on every block hash.

/**
 * Canonical per-transaction leaf. Commits to every consensus-relevant field,
 * including the client `id` and the per-sender `nonce` (H2). Amounts/fees are
 * normalised through to8() so float representation can't change the leaf.
 */
export function canonicalTxLeaf(t: {
  id: string; from: string; to: string; amount: number; fee: number;
  feeRate: number; timestamp: number; nonce?: string; memo?: string;
  publicKey: string; signature: string;
}): string {
  return [
    String(t.id ?? "") + "\x1f",
    String(t.from ?? "") + "\x1f",
    String(t.to ?? "") + "\x1f",
    to8(Number(t.amount ?? 0)) + "\x1f",
    to8(Number(t.fee ?? 0)) + "\x1f",
    Math.floor(Number(t.feeRate ?? 0)) + "\x1f",
    Math.floor(Number(t.timestamp ?? 0)) + "\x1f",
    String(t.nonce ?? "") + "\x1f",
    String(t.memo ?? "") + "\x1f",
    String(t.publicKey ?? "") + "\x1f",
    String(t.signature ?? "") + "\x1f",
  ].join(""); // USEP: cannot appear in any validated field [sep=0x1f]
}

/** sha256 over the ordered canonical tx leaves. Empty list -> sha256(""). */
export function computeTxRoot(transactions: Array<any> | null | undefined): string {
  if (!transactions || transactions.length === 0) return sha256hex("");
  return sha256hex(transactions.map(canonicalTxLeaf).join(""));
}

/**
 * Canonical per-entry leaf. Commits to the full mining-entry payload the
 * sealer packed so every peer re-derives the identical entryRoot and can
 * independently re-validate signature + PoW + simulator replay.
 */
export function canonicalEntryLeaf(e: {
  address: string; score: number; block_seed?: string | null;
  inputs_hash?: string | null; frame_count?: number | null;
  pow_nonce?: string | null; publicKey?: string | null; signature?: string | null;
}): string {
  return [
    String(e.address ?? "") + "\x1f",
    Math.floor(Number(e.score ?? 0)) + "\x1f",
    String(e.block_seed ?? "") + "\x1f",
    String(e.inputs_hash ?? "") + "\x1f",
    Math.floor(Number(e.frame_count ?? 0)) + "\x1f",
    String(e.pow_nonce ?? "") + "\x1f",
    String(e.publicKey ?? "") + "\x1f",
    String(e.signature ?? "") + "\x1f",
  ].join("");
}

/** sha256 over the ordered canonical entry leaves. Empty list -> sha256(""). */
export function computeEntryRoot(entries: Array<any> | null | undefined): string {
  if (!entries || entries.length === 0) return sha256hex("");
  return sha256hex(entries.map(canonicalEntryLeaf).join(""));
}

/** Canonical block hash. Order of fields MUST match the edge sealer. */
export function computeBlockHash(b: {
  height: number;
  previousHash: string;
  timestamp: number;
  winner: string | null;
  winnerScore: number;
  reward: number;
  seed: string;
  txCount: number;
  txRoot: string;
  entryRoot: string;
}): string {
  const header = [
    b.height,
    b.previousHash,
    b.timestamp,
    b.winner ?? "null",
    b.winnerScore,
    b.reward,
    b.seed,
    b.txCount,
    b.txRoot,
    b.entryRoot,
  ].join("|");
  return sha256hex(header);
}

// ── Proof-of-work for entry submissions ────────────────────────────────

/** Count leading zero bits of a hex-encoded sha256 digest. */
export function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) { bits += 4; continue; }
    // Add the leading zero bits of this nibble (1..3) and stop.
    if (nibble < 2) return bits + 3;
    if (nibble < 4) return bits + 2;
    if (nibble < 8) return bits + 1;
    return bits;
  }
  return bits;
}

/** Canonical PoW payload bound to (height, address, inputs_hash, nonce). */
export function entryPowPayload(
  block_height: number,
  address: string,
  inputs_hash: string,
  nonce: string,
): string {
  return `${block_height}:${address}:${inputs_hash}:${nonce}`;
}

/** Verify that `nonce` solves PoW for the given binding at >= ENTRY_POW_BITS bits. */
export function verifyEntryPow(
  block_height: number,
  address: string,
  inputs_hash: string,
  nonce: string,
  bits: number = ENTRY_POW_BITS,
): boolean {
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > 32) return false;
  const digest = sha256hex(entryPowPayload(block_height, address, inputs_hash, nonce));
  return leadingZeroBits(digest) >= bits;
}

/** Deterministic, attacker-grindable-but-pointless tie-break key for reorgs. */
export function tieBreakKey(blockHash: string, prevHash: string, height: number): string {
  return sha256hex(`${blockHash}|${prevHash}|${seedForHeight(height)}`);
}
