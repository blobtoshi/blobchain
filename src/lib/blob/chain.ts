import { sha256hex } from "./crypto";
import { to8 } from "./fees";
import {
  BLOCK_TIME, INITIAL_REWARD, HALVING_BLOCKS, GENESIS_TIME_MS, TX_FEE,
} from "./constants";
import { runtimeSeedForHeightSync } from "./runtimeSeed";

// Mulberry32 PRNG
export function mkPrng(seed) {
  let s = (Math.abs(+seed) * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function getRewardForHeight(height) {
  const halvings = Math.floor(height / HALVING_BLOCKS);
  return Math.min(INITIAL_REWARD / Math.pow(2, halvings), INITIAL_REWARD);
}

export function getBlockInfo(chain?: any[], hasEntry?: boolean) {
  const tip = chain && chain.length > 0 ? chain[chain.length - 1] : null;
  const prevHeight = tip ? Number(tip.height) : 0;
  const prevTs = tip ? Number(tip.timestamp) : GENESIS_TIME_MS;
  const prevHash = tip ? String(tip.hash ?? "") : null;
  const height = prevHeight + 1;
  const elapsed = Math.max(0, Math.floor((Date.now() - prevTs) / 1000));
  const remaining = Math.max(0, BLOCK_TIME - elapsed);
  const overdue = elapsed >= BLOCK_TIME;
  const awaitingMiner = overdue && !hasEntry;
  const overtime = overdue ? elapsed - BLOCK_TIME : 0;
  const reward = getRewardForHeight(height);
  // Runtime seed: bound to prev block's hash so the obstacle layout cannot be
  // pre-solved by offline bots before block H-1 is sealed. Falls back to the
  // cosmetic seed at genesis.
  const seed = runtimeSeedForHeightSync(height, prevHash);
  return {
    height, elapsed, remaining, reward,
    seed,
    prevHash,
    awaitingMiner, overtime, overdue,
  };
}

export async function computeBlockHash(b) {
  const header = [
    b.height, b.previousHash, b.timestamp,
    b.winner || "null", b.winnerScore, b.reward, b.seed,
    b.transactions.length,
  ].join("|");
  return sha256hex(header);
}

export function calcBalance(address, chain, mempool?: any[]) {
  let bal = 0;
  for (const block of chain) {
    if (block.winner === address) bal += (block.reward || 0);
    for (const tx of (block.transactions || [])) {
      if (tx.to === address) bal += tx.amount;
      if (tx.from === address) bal -= (tx.amount + (tx.fee || TX_FEE));
    }
  }
  if (mempool && mempool.length) {
    for (const tx of mempool) {
      if (tx.from === address) bal -= (tx.amount + (tx.fee || TX_FEE));
    }
  }
  return to8(Math.max(0, bal));
}

export function calcTotalSupply(chain) {
  return chain.reduce((s, b) => s + (b.reward || 0), 0);
}

export function pickWinner(entries, blockSeed) {
  if (!entries || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.address < b.address ? -1 : 1);
  const total = sorted.reduce((s, e) => s + e.score, 0);
  if (total === 0) return sorted[0];
  const rng = mkPrng(blockSeed);
  let target = rng() * total;
  for (const e of sorted) {
    target -= e.score;
    if (target <= 0) return e;
  }
  return sorted[sorted.length - 1];
}

export function winProbability(score, allEntries) {
  const total = allEntries.reduce((s, e) => s + e.score, 0);
  if (total === 0) return 0;
  return +((score / total) * 100).toFixed(1);
}
