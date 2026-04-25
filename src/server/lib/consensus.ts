// Consensus rules. These constants and functions MUST stay byte-for-byte in
// sync with `supabase/functions/seal-block` and `src/lib/blob/chain.ts`,
// otherwise full nodes will produce different block hashes than the rest of
// the network and fork the chain.

import { sha256hex } from "./crypto.js";

export const BLOCK_TIME_SECONDS = 120;
export const INITIAL_REWARD = 10;
export const HALVING_BLOCKS = 1_000_000;
export const MAX_SUPPLY = 20_000_000;
export const GENESIS_TIME_MS = 1_777_084_251_161;
export const GENESIS_HASH =
  "412c22f77b50de1a3faec282597d49b58a04bb5161e6d414f9885ab09de24bc7";

export const MAX_BLOCK_SIZE = 1_000_000; // 1 MB
export const MAX_TX_SIZE = 100_000;      // 100 KB
export const BLOB_UNIT = 1e8;

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

/** Deterministic seed for block N — same formula as the edge sealer. */
export function seedForHeight(height: number): number {
  // Use BigInt to avoid 53-bit float drift on the multiplication.
  const seedBig = BigInt(height) * 6364136223846793n + 1442695040888963407n;
  // Edge function does `seedNum % 2147483647`; reproduce that with BigInt.
  return Number(seedBig % 2147483647n < 0n
    ? -(seedBig % 2147483647n)
    : seedBig % 2147483647n);
}

export type EntryForSelection = {
  address: string;
  score: number;
  signature: string;
};

/** Weighted lottery winner selection. Sorted by address for determinism. */
export function pickWinner<T extends EntryForSelection>(
  entries: T[],
  blockSeed: number,
): T | null {
  if (!entries?.length) return null;
  const sorted = [...entries].sort((a, b) => (a.address < b.address ? -1 : 1));
  const total = sorted.reduce((s, e) => s + Number(e.score || 0), 0);
  if (total === 0) return sorted[0] ?? null;
  const rng = mkPrng(blockSeed);
  let target = rng() * total;
  for (const e of sorted) {
    target -= Number(e.score || 0);
    if (target <= 0) return e;
  }
  return sorted[sorted.length - 1] ?? null;
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
  ].join("|");
  return sha256hex(header);
}
