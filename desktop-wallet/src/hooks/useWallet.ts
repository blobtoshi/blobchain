import { useCallback, useEffect, useRef, useState } from "react";
import {
  getStoredWalletPublic, unlockWallet, clearWallet,
  type WalletPlain, type WalletPublic,
} from "../lib/vault";
import { wipeWallet } from "../lib/secret";

// Centralized wallet lifecycle:
//   loading → null (no vault) → pub-only (locked) → plain (unlocked).
// Auto-locks after `idleLockMs` of no user input, and on window blur if
// `lockOnBlur` is set. On lock we wipe the in-memory plain wallet.
export type WalletState = {
  loading: boolean;
  pub: WalletPublic | null;
  plain: WalletPlain | null;
};

export type WalletControls = {
  setPub: (p: WalletPublic | null) => void;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  forget: () => Promise<void>;
};

const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000;

export function useWallet(opts?: { idleLockMs?: number; lockOnBlur?: boolean }): WalletState & WalletControls {
  const idleLockMs = opts?.idleLockMs ?? DEFAULT_IDLE_LOCK_MS;
  const lockOnBlur = opts?.lockOnBlur ?? false;

  const [loading, setLoading] = useState(true);
  const [pub, setPubState] = useState<WalletPublic | null>(null);
  const [plain, setPlain] = useState<WalletPlain | null>(null);
  const plainRef = useRef<WalletPlain | null>(null);
  plainRef.current = plain;

  // Boot: load vault metadata.
  useEffect(() => {
    let alive = true;
    (async () => {
      const p = await getStoredWalletPublic();
      if (!alive) return;
      setPubState(p);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const lock = useCallback(() => {
    const cur = plainRef.current;
    if (cur) wipeWallet(cur);
    setPlain(null);
  }, []);

  const setPub = useCallback((p: WalletPublic | null) => {
    setPubState(p);
    if (!p) lock();
  }, [lock]);

  const unlock = useCallback(async (passphrase: string) => {
    const w = await unlockWallet(passphrase);
    setPlain(w);
  }, []);

  const forget = useCallback(async () => {
    lock();
    await clearWallet();
    setPubState(null);
  }, [lock]);

  // Idle-based auto-lock.
  useEffect(() => {
    if (!plain) return;
    let timer = window.setTimeout(lock, idleLockMs);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(lock, idleLockMs);
    };
    const events = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
  }, [plain, idleLockMs, lock]);

  // Optional blur-based lock.
  useEffect(() => {
    if (!plain || !lockOnBlur) return;
    const onBlur = () => lock();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [plain, lockOnBlur, lock]);

  // Wipe on unmount.
  useEffect(() => () => { if (plainRef.current) wipeWallet(plainRef.current); }, []);

  return { loading, pub, plain, setPub, unlock, lock, forget };
}
