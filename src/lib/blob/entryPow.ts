// Browser-side entry proof-of-work. Mirrors node/lib/consensus.ts's
// `verifyEntryPow` byte-for-byte so a nonce found here is accepted by the
// network with no further coordination.
//
// Why PoW: spinning up thousands of wallets to dilute the lottery is cheap
// without it. ENTRY_POW_BITS = 18 means ~262k sha256 hashes per submission —
// trivial for a real player (~0.5–1.5s on phones) but expensive for sybil
// rigs that need to do it for every fake address every block.

import { sha256hex } from "./crypto";

// Keep these constants in sync with node/lib/consensus.ts.
export const ENTRY_POW_BITS = 18;
export const ENTRY_REVEAL_WINDOW_SECONDS = 30;

function leadingZeroBits(hex: string): number {
  let bits = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) { bits += 4; continue; }
    if (nibble < 2) return bits + 3;
    if (nibble < 4) return bits + 2;
    if (nibble < 8) return bits + 1;
    return bits;
  }
  return bits;
}

export function entryPowPayload(
  block_height: number, address: string, commit_hash: string, nonce: string,
): string {
  return `${block_height}:${address}:${commit_hash}:${nonce}`;
}

export type PowProgress = (hashes: number) => void;

/**
 * Search for a nonce that satisfies ENTRY_POW_BITS leading-zero bits.
 * Runs on the main thread but yields every 4096 hashes so the UI stays
 * responsive. Typical wall-time: 0.5–2 seconds.
 */
export async function mineEntryPow(
  block_height: number,
  address: string,
  commit_hash: string,
  bits: number = ENTRY_POW_BITS,
  onProgress?: PowProgress,
): Promise<{ nonce: string; hashes: number }> {
  let n = 0;
  while (true) {
    for (let i = 0; i < 4096; i++) {
      const nonce = (n++).toString(16);
      const digest = await sha256hex(entryPowPayload(block_height, address, commit_hash, nonce));
      if (leadingZeroBits(digest) >= bits) return { nonce, hashes: n };
    }
    onProgress?.(n);
    // Yield to the event loop so the page doesn't lock up.
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 16-byte hex salt used to blind commit_hash from the wire. */
export function randomSalt(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let s = ""; for (let i = 0; i < buf.length; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

/** commit_hash = sha256(score || "|" || inputs_hash || "|" || salt). */
export async function commitHash(score: number, inputs_hash: string, salt: string): Promise<string> {
  return sha256hex(`${Math.floor(score)}|${inputs_hash}|${salt}`);
}
