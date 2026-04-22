

## Harden `src/lib/walletVault.ts`

Three small, focused improvements to the wallet vault — no behavior change for existing users who can still unlock their current vault.

### 1. Replace custom base64 with `@scure/base`

`@scure/base` is already in the project (used by `src/lib/blob/crypto.ts`). Import its `base64` codec and replace the hand-rolled `b64` / `unb64` helpers, which use `String.fromCharCode` + `btoa` and can mis-handle bytes outside the Latin-1 range.

```ts
import { base64 } from "@scure/base";
// b64(bytes)  -> base64.encode(bytes)
// unb64(str)  -> base64.decode(str)
```

All call sites (`salt`, `iv`, `ct`) already pass `Uint8Array`, so the swap is direct.

### 2. Bump PBKDF2 iterations to 600,000

Change the default iteration count for **new** vaults from `250_000` to `600_000` (OWASP 2023 recommendation for PBKDF2-HMAC-SHA256). Existing vaults remain unlockable because `unlockWallet` already reads `v.enc.iter` from the stored vault and falls back per-record — only newly written vaults get the higher count.

### 3. Validate vault structure before decrypting

In `unlockWallet`, after `JSON.parse`, assert the shape before touching crypto so corrupt/foreign payloads fail fast with a clear error instead of a cryptic decode/decrypt exception:

- `v.v === 1`
- `typeof v.address === "string"`
- `typeof v.publicKey === "string"`
- `v.enc` is an object with string fields `salt`, `iv`, `ct`, and (optional) numeric `iter`

Each missing/invalid field throws `new Error("Corrupt wallet vault")`. The existing "Wrong passphrase" branch is preserved for genuine decryption failures.

### Out of scope

- No changes to vault key name, version, or storage layout — current users keep their wallet.
- No changes to `src/hooks/useWalletVault.ts` or any other consumer; the public API (`saveEncryptedWallet`, `unlockWallet`, `getStoredWalletPublic`, `clearWallet`, `purgeLegacyPlaintextWallet`, types) stays identical.
- Legacy key purge logic is left as-is.

### Verification

`tsc --noEmit` to confirm types still line up.

