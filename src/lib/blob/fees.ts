// @ts-nocheck
import { BLOB_UNIT } from "./constants";

export const to8 = (n: number) => Math.round(Number(n) * BLOB_UNIT) / BLOB_UNIT;

export function canonicalTxBytes(tx: {
  from: string; to: string; amount: number; timestamp: number;
  feeRate: number; memo: string; publicKey: string; signature: string;
}): number {
  const canonical = JSON.stringify({
    from: tx.from, to: tx.to, amount: tx.amount, timestamp: tx.timestamp,
    feeRate: tx.feeRate, memo: tx.memo, publicKey: tx.publicKey, signature: tx.signature,
  });
  return new TextEncoder().encode(canonical).length;
}

export const memoBytes = (m: string) => new TextEncoder().encode(m).length;

export function estimateTxBytes(from: string, to: string, amount: number, ts: number, feeRate: number, memo: string) {
  const fakeSig = "00".repeat(64);
  const fakePub = "02" + "00".repeat(32);
  return canonicalTxBytes({
    from, to, amount, timestamp: ts, feeRate, memo,
    publicKey: fakePub, signature: fakeSig,
  });
}

export const feeFromRate = (feeRate: number, bytes: number) => Math.ceil(feeRate * bytes) / BLOB_UNIT;
