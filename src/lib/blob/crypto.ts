// secp256k1 wallet + signing primitives shared across the UI.
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

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

// ── BIP39 seed-phrase support ────────────────────────────────────────────────
// 12-word mnemonic (128 bits entropy). The secp256k1 private key is derived
// deterministically from the BIP39 seed by taking the first 32 bytes of the
// PBKDF2-HMAC-SHA512 output. Fully reversible from the mnemonic alone.

export function generateMnemonic12(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizeMnemonic(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidMnemonic(phrase: string): boolean {
  try { return validateMnemonic(normalizeMnemonic(phrase), wordlist); }
  catch { return false; }
}

export function mnemonicToPrivateKey(phrase: string): string {
  const seed = mnemonicToSeedSync(normalizeMnemonic(phrase));
  let priv: Uint8Array = seed.slice(0, 32);
  if (!secp.utils.isValidPrivateKey(priv)) priv = sha256(seed);
  return bytesToHex(priv);
}

export async function generateWallet() {
  const mnemonic = generateMnemonic12();
  const privateKey = mnemonicToPrivateKey(mnemonic);
  const pub = secp.getPublicKey(hexToBytes(privateKey), true);
  const publicKey = bytesToHex(pub);
  const address = pubKeyToAddress(publicKey);
  return { address, publicKey, privateKey, mnemonic };
}

export async function signData(privHex: string, data: string) {
  try {
    const msgHash = sha256(enc.encode(data));
    const sig = await secp.signAsync(msgHash, hexToBytes(privHex));
    return sig.toCompactHex();
  } catch { return ""; }
}
