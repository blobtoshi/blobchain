// Web Worker that mines entry PoW off the main thread.
//
// Why a worker:
//   The old mineEntryPow loop ran on the main thread and called
//   `crypto.subtle.digest` ~262k times. Even with a setTimeout(0) yield
//   every 4096 hashes, that's 64 yields each one going through the
//   microtask queue + a fresh subtle.digest Promise. On low-end Android
//   that adds up to multi-second main-thread blocking right after the
//   player dies, which everyone perceives as the game being laggy /
//   frozen. Moving it here keeps the main thread free for rendering and
//   touch input while PoW runs.
//
// Why noble's sync sha256 instead of crypto.subtle:
//   subtle.digest is async — every iteration costs a microtask.
//   noble/hashes ships a synchronous SHA-256 that we can call in a tight
//   loop with zero await overhead. SHA-256 is SHA-256, the verifier on
//   the node accepts the same nonce either way.
//
// Wire format (postMessage):
//   in : { type: "mine", block_height, address, commit_hash, bits }
//   out: { type: "progress", hashes }   — sent every PROGRESS_EVERY tries
//        { type: "found", nonce, hashes }
//        { type: "error", error }

import { sha256 } from "@noble/hashes/sha256";

const enc = new TextEncoder();

function sha256hex(s: string): string {
  const out = sha256(enc.encode(s));
  let hex = "";
  for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, "0");
  return hex;
}

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

const PROGRESS_EVERY = 16384;

self.onmessage = (ev: MessageEvent) => {
  const data = ev.data;
  if (!data || data.type !== "mine") return;
  const { block_height, address, commit_hash, bits } = data as {
    block_height: number; address: string; commit_hash: string; bits: number;
  };
  try {
    let n = 0;
    while (true) {
      const nonce = n.toString(16);
      const payload = `${block_height}:${address}:${commit_hash}:${nonce}`;
      if (leadingZeroBits(sha256hex(payload)) >= bits) {
        (self as unknown as Worker).postMessage({ type: "found", nonce, hashes: n + 1 });
        return;
      }
      n++;
      if ((n & (PROGRESS_EVERY - 1)) === 0) {
        (self as unknown as Worker).postMessage({ type: "progress", hashes: n });
      }
      // Safety ceiling — at 18 bits average is 262k, 99.99% of runs finish
      // by 4M. Anything past that is almost certainly a stuck loop.
      if (n > 50_000_000) {
        (self as unknown as Worker).postMessage({ type: "error", error: "pow exhausted" });
        return;
      }
    }
  } catch (e) {
    (self as unknown as Worker).postMessage({
      type: "error",
      error: (e as Error)?.message ?? String(e),
    });
  }
};
