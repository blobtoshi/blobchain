import { base64 } from "@scure/base";

const VAULT_KEY = "blob_wallet_vault_v2"; // v2: secp256k1 hex keys (Bitcoin-style)
const LEGACY_KEYS = ["blob_wallet_v2", "blob_wallet_vault_v1"]; // older formats to purge

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase) as BufferSource,
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: iter, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type WalletPlain = {
  address: string;
  publicKey: string; // JWK string
  privateKey: string; // JWK string
  username: string;
};

export type WalletPublic = {
  address: string;
  publicKey: string;
  username: string;
};

export async function saveEncryptedWallet(w: WalletPlain, passphrase: string) {
  if (!passphrase || passphrase.length < 6) {
    throw new Error("Passphrase must be at least 6 characters");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iter = 600_000; // OWASP 2023 recommendation for PBKDF2-HMAC-SHA256
  const key = await deriveKey(passphrase, salt, iter);
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(w.privateKey));
  const ct = new Uint8Array(ctBuf);
  const vault = {
    v: 1,
    address: w.address,
    publicKey: w.publicKey,
    username: w.username,
    enc: {
      salt: base64.encode(salt),
      iv: base64.encode(iv),
      ct: base64.encode(ct),
      iter,
    },
  };
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  // Make sure no copies in older-format slots linger
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
}

export function getStoredWalletPublic(): WalletPublic | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v?.v !== 1 || !v.address || !v.publicKey) return null;
    return { address: v.address, publicKey: v.publicKey, username: v.username ?? "anon" };
  } catch {
    return null;
  }
}

export async function unlockWallet(passphrase: string): Promise<WalletPlain> {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) throw new Error("No wallet stored");

  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error("Corrupt wallet vault");
  }

  if (!v || typeof v !== "object") throw new Error("Corrupt wallet vault");
  if (v.v !== 1) throw new Error("Unsupported vault version");
  if (typeof v.address !== "string") throw new Error("Corrupt wallet vault");
  if (typeof v.publicKey !== "string") throw new Error("Corrupt wallet vault");
  if (!v.enc || typeof v.enc !== "object") throw new Error("Corrupt wallet vault");
  if (
    typeof v.enc.salt !== "string" ||
    typeof v.enc.iv !== "string" ||
    typeof v.enc.ct !== "string"
  ) {
    throw new Error("Corrupt wallet vault");
  }
  if (v.enc.iter !== undefined && typeof v.enc.iter !== "number") {
    throw new Error("Corrupt wallet vault");
  }

  let salt: Uint8Array;
  let iv: Uint8Array;
  let ct: Uint8Array;
  try {
    // Copy into fresh ArrayBuffer-backed Uint8Arrays to satisfy BufferSource typing.
    salt = new Uint8Array(base64.decode(v.enc.salt));
    iv = new Uint8Array(base64.decode(v.enc.iv));
    ct = new Uint8Array(base64.decode(v.enc.ct));
  } catch {
    throw new Error("Corrupt wallet vault");
  }

  const key = await deriveKey(passphrase, salt, v.enc.iter ?? 250_000);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      ct as unknown as BufferSource,
    );
  } catch {
    throw new Error("Wrong passphrase");
  }
  const privateKey = dec.decode(plainBuf);
  return {
    address: v.address,
    publicKey: v.publicKey,
    privateKey,
    username: v.username ?? "anon",
  };
}

export function clearWallet() {
  localStorage.removeItem(VAULT_KEY);
  for (const k of LEGACY_KEYS) localStorage.removeItem(k);
}

// One-time cleanup: remove legacy/older-format wallets from any browser that
// still has them. Old (P-256/JWK) wallets can't sign for the new chain anyway.
export function purgeLegacyPlaintextWallet() {
  for (const k of LEGACY_KEYS) {
    if (localStorage.getItem(k)) localStorage.removeItem(k);
  }
}
