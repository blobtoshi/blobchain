// Shared score-weighting for the BlobChain mining lottery.
//
// MUST stay byte-for-byte identical to node/lib/lottery.ts. Nodes that
// disagree on weights will pick different winners → chain fork.
//
// Anti-bot threshold: scores below MIN_LEGITIMATE_SCORE are crushed by
// SUB_THRESHOLD_DAMPER (1e-6) and an additional (s / MIN)^8 falloff. At
// score 50 that's ≈ 4e-12 weight — 11 orders of magnitude below a real
// run at score 500. A million sybil entries at score 50 still sum to
// less weight than one legitimate run.
//
// To soften this if it ever proves too aggressive, raise SUB_THRESHOLD_DAMPER
// or lower the falloff exponent. Lowering MIN_LEGITIMATE_SCORE is a chain
// rule change; coordinate across all nodes before doing it.

export const MIN_LEGITIMATE_SCORE = 200;
export const POWER = 4;
export const SUB_THRESHOLD_DAMPER = 1e-6;
export const SUB_THRESHOLD_EXP = 8;

export function scoreWeight(score: number): number {
  const s = Number(score);
  if (!Number.isFinite(s) || s <= 0) return 0;
  if (s < MIN_LEGITIMATE_SCORE) {
    return Math.pow(s / MIN_LEGITIMATE_SCORE, SUB_THRESHOLD_EXP) * SUB_THRESHOLD_DAMPER;
  }
  return Math.pow(s, POWER);
}
