// @ts-nocheck
// Wallet lifecycle: create / import / unlock / disconnect, plus username validation.
import { useEffect, useRef, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import * as Vault from "@/lib/walletVault";
import * as secp from "@noble/secp256k1";
import { supabase } from "@/integrations/supabase/client";
import { generateWallet, signData, bytesToHex, hexToBytes, pubKeyToAddress, isValidMnemonic, mnemonicToPrivateKey, normalizeMnemonic } from "@/lib/blob/crypto";
import { USERNAME_RE } from "@/lib/blob/constants";

export function useWalletVault() {
  const [wallet, setWallet] = useState<any>(null);
  const [vaultPub, setVaultPub] = useState<Vault.WalletPublic | null>(null);

  const walletRef = useRef(wallet);
  useEffect(() => { walletRef.current = wallet; }, [wallet]);

  useEffect(() => {
    Vault.purgeLegacyPlaintextWallet();
    setVaultPub(Vault.getStoredWalletPublic());
  }, []);

  async function validateUsername(name: string, ownAddress?: string): Promise<string | null> {
    const u = name.trim();
    if (!USERNAME_RE.test(u)) return "Username must be 3–24 chars (letters, numbers, _)";
    const { data } = await supabase.rpc("resolve_username", { p_username: u });
    const row = (data as any[])?.[0];
    if (row && row.address !== ownAddress) return `Username "${u}" is taken`;
    return null;
  }

  async function createWallet(name: string, pass: string): Promise<{ ok: true; mnemonic: string } | { ok: false; error: string }> {
    const nameErr = await validateUsername(name);
    if (nameErr) return { ok: false, error: nameErr };
    const w: any = await generateWallet();
    w.username = name;
    await Vault.saveEncryptedWallet(w, pass);
    const ts = Date.now();
    const sig = await signData(w.privateKey, `register:${w.address}:${name}:${ts}`);
    const reg = await Relay.registerPlayer({
      address: w.address, username: name, publicKey: w.publicKey, signature: sig, timestamp: ts,
    });
    if (!reg.ok) return { ok: false, error: reg.error || "Failed to register wallet" };
    setVaultPub({ address: w.address, publicKey: w.publicKey, username: w.username });
    setWallet(w);
    return { ok: true, mnemonic: w.mnemonic };
  }

  // secret = either a 64-hex private key or a 12-word BIP39 mnemonic.
  async function importWallet(name: string, secret: string, pass: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const raw = secret.trim();
    let priv = "";
    let mnemonic: string | undefined;
    const looksHex = /^(0x)?[0-9a-fA-F]{64}$/.test(raw);
    if (looksHex) {
      priv = raw.toLowerCase().replace(/^0x/, "");
    } else {
      const phrase = normalizeMnemonic(raw);
      const wordCount = phrase.split(" ").filter(Boolean).length;
      if (wordCount !== 12) return { ok: false, error: "Seed phrase must be exactly 12 words" };
      if (!isValidMnemonic(phrase)) return { ok: false, error: "Invalid seed phrase (checksum mismatch or unknown words)" };
      priv = mnemonicToPrivateKey(phrase);
      mnemonic = phrase;
    }
    let publicKey: string, address: string;
    try {
      publicKey = bytesToHex(secp.getPublicKey(hexToBytes(priv), true));
      address = pubKeyToAddress(publicKey);
    } catch {
      return { ok: false, error: "Invalid key material" };
    }
    const nameErr = await validateUsername(name, address);
    if (nameErr) return { ok: false, error: nameErr };
    const w: any = { address, publicKey, privateKey: priv, username: name };
    await Vault.saveEncryptedWallet(w, pass);
    const ts = Date.now();
    const sig = await signData(priv, `register:${address}:${name}:${ts}`);
    const reg = await Relay.registerPlayer({
      address, username: name, publicKey, signature: sig, timestamp: ts,
    });
    if (!reg.ok) return { ok: false, error: reg.error || "Failed to register wallet" };
    setVaultPub({ address: w.address, publicKey: w.publicKey, username: w.username });
    setWallet(w);
    return { ok: true };
  }

  async function unlockExisting(pass: string) {
    const w = await Vault.unlockWallet(pass);
    setWallet(w);
  }

  function disconnectWallet() {
    Vault.clearWallet();
    setWallet(null);
    setVaultPub(null);
  }

  return { wallet, vaultPub, walletRef, createWallet, importWallet, unlockExisting, disconnectWallet };
}
