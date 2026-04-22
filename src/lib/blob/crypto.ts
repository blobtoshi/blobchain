// @ts-nocheck
// secp256k1 wallet + signing primitives shared across the UI.
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";

const enc = new TextEncoder();
const b58check = base58check(sha256);

export async function sha256hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToHex(b: Uint8Array) {
  let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s;
}
export function hexToBytes(h: string) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

export function pubKeyToAddress(pubHex: string) {
  const pub = hexToBytes(pubHex);
  const h160 = ripemd160(sha256(pub));
  const payload = new Uint8Array(1 + 20);
  payload[0] = 0x00;
  payload.set(h160, 1);
  return b58check.encode(payload);
}

export async function generateWallet() {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true);
  const privateKey = bytesToHex(priv);
  const publicKey = bytesToHex(pub);
  const address = pubKeyToAddress(publicKey);
  return { address, publicKey, privateKey };
}

export async function signData(privHex: string, data: string) {
  try {
    const msgHash = sha256(enc.encode(data));
    const sig = await secp.signAsync(msgHash, hexToBytes(privHex));
    return sig.toCompactHex();
  } catch { return ""; }
}
