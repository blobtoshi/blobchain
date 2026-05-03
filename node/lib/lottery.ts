// MUST stay byte-for-byte identical to src/lib/blob/lottery.ts. See that
// file for full design rationale.

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
