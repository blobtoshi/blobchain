// Browser-side entry proof-of-work. Mirrors node/lib/consensus.ts's
// `verifyEntryPow` byte-for-byte so a nonce found here is accepted by the
// network with no further coordination.
//
// Why PoW: spinning up thousands of wallets to dilute the lottery is cheap
// without it. ENTRY_POW_BITS = 18 means ~262k sha256 hashes per submission —
// trivial for a real player (~0.5–1.5s on phones) but expensive for sybil
// rigs that need to do it for every fake address every block.
//
// As of the perf-pass, mining runs in a Web Worker (powWorker.ts) so the
// game canvas stays smooth on low-end devices. The main-thread loop here
// is kept as a fallback for environments where module workers fail to
// instantiate (very old Safari, Electron without nodeIntegration, etc.).

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

// Workers can be disabled by setting localStorage.blobNoPowWorker = "1".
// Useful for debugging or comparing perf.
function workerDisabled(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("blobNoPowWorker") === "1";
  } catch { return false; }
}

// Tries to mine in a Web Worker. Resolves with the worker's nonce, or
// rejects with "no-worker" if the runtime can't instantiate one — in which
// case the caller falls back to the main-thread implementation.
function mineInWorker(
  block_height: number,
  address: string,
  commit_hash: string,
  bits: number,
  onProgress?: PowProgress,
): Promise<{ nonce: string; hashes: number }> {
  return new Promise((resolve, reject) => {
    if (typeof Worker === "undefined" || workerDisabled()) {
      reject(new Error("no-worker"));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(new URL("./powWorker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      reject(new Error("no-worker"));
      return;
    }
    let settled = false;
    const cleanup = () => {
      try { worker.terminate(); } catch { /* ignore */ }
    };
    worker.onerror = (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`worker error: ${e.message ?? "unknown"}`));
    };
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (!m || settled) return;
      if (m.type === "progress") {
        onProgress?.(m.hashes);
      } else if (m.type === "found") {
        settled = true;
        cleanup();
        resolve({ nonce: m.nonce, hashes: m.hashes });
      } else if (m.type === "error") {
        settled = true;
        cleanup();
        reject(new Error(m.error || "worker rejected"));
      }
    };
    worker.postMessage({ type: "mine", block_height, address, commit_hash, bits });
  });
}

// Fallback: main-thread loop, used only when workers are unavailable.
async function mineOnMain(
  block_height: number,
  address: string,
  commit_hash: string,
  bits: number,
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
    await new Promise((r) => setTimeout(r, 0));
  }
}

/**
 * Search for a nonce that satisfies ENTRY_POW_BITS leading-zero bits.
 *
 * Runs in a Web Worker by default so the game canvas stays smooth even
 * on low-end devices. Falls back to the main-thread loop if the worker
 * can't be instantiated.
 */
export async function mineEntryPow(
  block_height: number,
  address: string,
  commit_hash: string,
  bits: number = ENTRY_POW_BITS,
  onProgress?: PowProgress,
): Promise<{ nonce: string; hashes: number }> {
  try {
    return await mineInWorker(block_height, address, commit_hash, bits, onProgress);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg !== "no-worker") {
      // Unexpected worker failure — log and fall back rather than failing
      // the submission.
      console.warn("[pow] worker failed, falling back to main thread:", msg);
    }
    return mineOnMain(block_height, address, commit_hash, bits, onProgress);
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
