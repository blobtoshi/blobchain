// @ts-nocheck
// Wallet lifecycle: create / import / unlock / disconnect, plus username validation.
import { useEffect, useRef, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import * as Vault from "@/lib/walletVault";
import * as secp from "@noble/secp256k1";
import { supabase } from "@/integrations/supabase/client";
import { generateWallet, signData, bytesToHex, hexToBytes, pubKeyToAddress } from "@/lib/blob/crypto";
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

  async function createWallet(name: string, pass: string): Promise<{ ok: true } | { ok: false; error: string }> {
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
    return { ok: true };
  }

  async function importWallet(name: string, privKeyHex: string, pass: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const priv = privKeyHex.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(priv)) return { ok: false, error: "Private key must be 64 hex characters (32 bytes)" };
    let publicKey: string, address: string;
    try {
      publicKey = bytesToHex(secp.getPublicKey(hexToBytes(priv), true));
      address = pubKeyToAddress(publicKey);
    } catch {
      return { ok: false, error: "Invalid private key" };
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
