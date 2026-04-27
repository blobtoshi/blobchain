// Bridge to vault file in Electron's userData directory.
// Vault JSON shape is identical to the web app's localStorage vault, so a
// user can migrate by pasting the same JSON or by re-importing their mnemonic.

declare global {
  interface Window {
    vaultBridge?: {
      read(): Promise<string | null>;
      write(json: string): Promise<boolean>;
      clear(): Promise<boolean>;
    };
    nodeConfigBridge?: {
      read(): Promise<string | null>;
      write(json: string): Promise<boolean>;
    };
  }
}

import { base64 } from "@scure/base";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(passphrase: string, salt: Uint8Array, iter: number) {
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), { name: "PBKDF2" }, false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export type WalletPlain = {
  address: string;
  publicKey: string;
  privateKey: string;
  mnemonic?: string;
};
export type WalletPublic = { address: string; publicKey: string };

export async function saveEncryptedWallet(w: WalletPlain, passphrase: string) {
  if (!passphrase || passphrase.length < 6) throw new Error("Passphrase must be at least 6 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iter = 600_000;
  const key = await deriveKey(passphrase, salt, iter);
  const payload = JSON.stringify({ privateKey: w.privateKey, mnemonic: w.mnemonic ?? null });
  const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(payload));
  const vault = {
    v: 1,
    address: w.address,
    publicKey: w.publicKey,
    enc: {
      salt: base64.encode(salt),
      iv: base64.encode(iv),
      ct: base64.encode(new Uint8Array(ctBuf)),
      iter,
    },
  };
  await window.vaultBridge!.write(JSON.stringify(vault));
}

export async function getStoredWalletPublic(): Promise<WalletPublic | null> {
  const raw = await window.vaultBridge!.read();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.v !== 1 || !v.address || !v.publicKey) return null;
    return { address: v.address, publicKey: v.publicKey };
  } catch { return null; }
}

export async function unlockWallet(passphrase: string): Promise<WalletPlain> {
  const raw = await window.vaultBridge!.read();
  if (!raw) throw new Error("No wallet stored");
  const v = JSON.parse(raw);
  const salt = new Uint8Array(base64.decode(v.enc.salt));
  const iv = new Uint8Array(base64.decode(v.enc.iv));
  const ct = new Uint8Array(base64.decode(v.enc.ct));
  const key = await deriveKey(passphrase, salt, v.enc.iter ?? 250_000);
  let plainBuf: ArrayBuffer;
  try {
    plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch { throw new Error("Wrong passphrase"); }
  const obj = JSON.parse(dec.decode(plainBuf));
  return {
    address: v.address,
    publicKey: v.publicKey,
    privateKey: obj.privateKey,
    mnemonic: obj.mnemonic || undefined,
  };
}

export async function clearWallet() { await window.vaultBridge!.clear(); }
