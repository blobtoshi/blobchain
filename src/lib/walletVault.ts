// Wallet vault — encrypts the ECDSA P-256 private key (JWK) at rest in
// localStorage using AES-GCM with a passphrase-derived key (PBKDF2-SHA256).
//
// Storage format (versioned so we can migrate later):
//   {
//     v: 1,
//     address: "0x...",
//     publicKey: "<JWK string>",
//     username: "...",
//     enc: { salt: <b64>, iv: <b64>, ct: <b64>, iter: 250000 }
//   }

const VAULT_KEY = "blob_wallet_vault_v1";
const LEGACY_KEY = "blob_wallet_v2"; // plaintext storage we are retiring

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function unb64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
  publicKey: string;   // JWK string
  privateKey: string;  // JWK string
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
  const iter = 250_000;
  const key = await deriveKey(passphrase, salt, iter);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(w.privateKey),
  );
  const vault = {
    v: 1,
    address: w.address,
    publicKey: w.publicKey,
    username: w.username,
    enc: { salt: b64(salt), iv: b64(iv), ct: b64(ct), iter },
  };
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
  // Make sure no plaintext copy lingers
  localStorage.removeItem(LEGACY_KEY);
}

export function getStoredWalletPublic(): WalletPublic | null {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v?.v !== 1 || !v.address || !v.publicKey) return null;
    return { address: v.address, publicKey: v.publicKey, username: v.username ?? "anon" };
  } catch { return null; }
}

export async function unlockWallet(passphrase: string): Promise<WalletPlain> {
  const raw = localStorage.getItem(VAULT_KEY);
  if (!raw) throw new Error("No wallet stored");
  const v = JSON.parse(raw);
  if (v?.v !== 1) throw new Error("Unsupported vault version");
  const salt = unb64(v.enc.salt);
  const iv = unb64(v.enc.iv);
  const ct = unb64(v.enc.ct);
  const key = await deriveKey(passphrase, salt, v.enc.iter ?? 250_000);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
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
  localStorage.removeItem(LEGACY_KEY);
}

// One-time cleanup: remove the legacy plaintext wallet from any browser that
// still has it from before encryption was introduced.
export function purgeLegacyPlaintextWallet() {
  if (localStorage.getItem(LEGACY_KEY)) {
    localStorage.removeItem(LEGACY_KEY);
  }
}
