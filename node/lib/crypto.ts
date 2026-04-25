// Node-side wrappers around the same noble libs the edge functions use.
// Keeping this thin makes it easy to spot consensus drift between client,
// edge function, and full node.

import { createHash } from "node:crypto";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";

const enc = new TextEncoder();
const b58check = base58check(sha256);

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

/** Derive the P2PKH base58check address from a 33-byte compressed pubkey hex. */
export function pubKeyToAddress(pubHex: string): string {
  const pub = hexToBytes(pubHex);
  const h160 = ripemd160(sha256(pub));
  const payload = new Uint8Array(1 + 20);
  payload[0] = 0x00;
  payload.set(h160, 1);
  return b58check.encode(payload);
}

/** Verify a secp256k1 signature over the SHA-256 of `data`. */
export function verifySig(pubHex: string, sigHex: string, data: string): boolean {
  try {
    const msgHash = sha256(enc.encode(data));
    return secp.verify(hexToBytes(sigHex), msgHash, hexToBytes(pubHex));
  } catch {
    return false;
  }
}
