// Best-effort zeroization of sensitive strings. JS strings are immutable so we
// can never truly wipe them, but we can drop references promptly, overwrite
// any Uint8Array buffers we control, and pre-emptively clear any object
// holding a privateKey/mnemonic before it becomes garbage.

import type { WalletPlain } from "./vault";

export function wipeBytes(buf: Uint8Array | null | undefined) {
  if (!buf) return;
  try { buf.fill(0); } catch { /* ignore */ }
}

// Mutate a WalletPlain in place so any closure still holding it sees an
// empty object. Strings can't be wiped, but properties are removed.
export function wipeWallet(w: WalletPlain | null | undefined) {
  if (!w) return;
  try {
    // Overwrite then delete; reduces the window an attacker has to read.
    (w as any).privateKey = "";
    (w as any).mnemonic = "";
    (w as any).publicKey = "";
    (w as any).address = "";
  } catch { /* ignore */ }
}
