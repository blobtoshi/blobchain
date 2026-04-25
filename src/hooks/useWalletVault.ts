// @ts-nocheck
// Wallet lifecycle: create / import / unlock / disconnect.
// A wallet is identified solely by its address — there is no username.
import { useEffect, useRef, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import * as Vault from "@/lib/walletVault";
import * as secp from "@noble/secp256k1";
import {
  generateWallet, signData, bytesToHex, hexToBytes, pubKeyToAddress,
  isValidMnemonic, mnemonicToPrivateKey, normalizeMnemonic,
} from "@/lib/blob/crypto";

export function useWalletVault() {
  const [wallet, setWallet] = useState<any>(null);
  const [vaultPub, setVaultPub] = useState<Vault.WalletPublic | null>(null);

  const walletRef = useRef(wallet);
  useEffect(() => { walletRef.current = wallet; }, [wallet]);

  useEffect(() => {
    Vault.purgeLegacyPlaintextWallet();
    setVaultPub(Vault.getStoredWalletPublic());
  }, []);

  async function createWallet(pass: string): Promise<{ ok: true; mnemonic: string } | { ok: false; error: string }> {
    const w: any = await generateWallet();
    await Vault.saveEncryptedWallet(w, pass);
    const ts = Date.now();
    const sig = await signData(w.privateKey, `register:${w.address}:${ts}`);
    const reg = await Relay.registerAddress({
      address: w.address, publicKey: w.publicKey, signature: sig, timestamp: ts,
    });
    if (!reg.ok) return { ok: false, error: reg.error || "Failed to register wallet" };
    setVaultPub({ address: w.address, publicKey: w.publicKey });
    setWallet(w);
    return { ok: true, mnemonic: w.mnemonic };
  }

  // secret = either a 64-hex private key or a 12-word BIP39 mnemonic.
  async function importWallet(secret: string, pass: string): Promise<{ ok: true } | { ok: false; error: string }> {
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
    const w: any = { address, publicKey, privateKey: priv, mnemonic };
    await Vault.saveEncryptedWallet(w, pass);
    const ts = Date.now();
    const sig = await signData(priv, `register:${address}:${ts}`);
    const reg = await Relay.registerAddress({
      address, publicKey, signature: sig, timestamp: ts,
    });
    if (!reg.ok) return { ok: false, error: reg.error || "Failed to register wallet" };
    setVaultPub({ address: w.address, publicKey: w.publicKey });
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
