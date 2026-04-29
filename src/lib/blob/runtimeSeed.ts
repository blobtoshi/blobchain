// Browser-side helper: derive the runtime obstacle seed for an active height.
//
// MUST stay in sync with node/lib/consensus.ts → runtimeSeedForHeight.
// Bound to the previous block's hash so the level layout for height H cannot
// be pre-computed offline before block H-1 is sealed.

import { sha256 } from "@noble/hashes/sha256";
import { sha256hex } from "./crypto";

const enc = new TextEncoder();

function sha256hexSync(s: string): string {
  const out = sha256(enc.encode(s));
  let h = ""; for (let i = 0; i < out.length; i++) h += out[i].toString(16).padStart(2, "0");
  return h;
}

/** Cosmetic seed (used only as a fallback when there's no prev block). */
export function publicSeedForHeight(height: number): number {
  const seedBig = BigInt(height) * 6364136223846793n + 1442695040888963407n;
  const mod = seedBig % 2147483647n;
  return Number(mod < 0n ? -mod : mod);
}

/** Sync runtime seed — used in the rAF render path / level generation. */
export function runtimeSeedForHeightSync(
  height: number, prevHash: string | null | undefined,
): number {
  if (!prevHash || height <= 1) return publicSeedForHeight(height);
  const hex = sha256hexSync(`${prevHash}:${height}`);
  return parseInt(hex.slice(0, 8), 16) & 0x7fffffff;
}

/** Async variant — kept for parity with edge code. */
export async function runtimeSeedForHeight(
  height: number, prevHash: string | null | undefined,
): Promise<number> {
  if (!prevHash || height <= 1) return publicSeedForHeight(height);
  const hex = await sha256hex(`${prevHash}:${height}`);
  return parseInt(hex.slice(0, 8), 16) & 0x7fffffff;
}

