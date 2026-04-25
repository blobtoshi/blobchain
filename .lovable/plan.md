## Goal

Remove wallet usernames entirely. A wallet is identified solely by its address. The X (Twitter) handle field on the alpha access gate stays untouched — that is unrelated.

## What changes for the user

- Wallet creation no longer asks for a username — only a passphrase.
- Wallet import no longer asks for a username.
- Send form no longer accepts `@handle` recipients — only addresses.
- Anywhere a name used to appear (wallet header, tx history, mining leaderboard, block winner, mempool, explorer, bridge), a shortened address (`1A2b…xY9z`) is shown instead.
- Every shortened address becomes a clickable chip that jumps to that account in the Explorer's account drawer (existing behavior, just made consistent).

## Files to change

### Frontend — UI

- `src/pages/Index.tsx` — drop username state, validation, and inputs from create/import dialogs; drop the seed reveal "username" mention; drop username from settings.
- `src/components/blob/WalletScreen.tsx` — remove `@username` line in header; show shortened address; replace `fromUsername` fallbacks with `shortAddress(...)`.
- `src/components/blob/SendTxForm.tsx` — strip `@username` resolution path, the `resolve_username` RPC call, and the related UI states/messages; recipient input becomes "address only".
- `src/components/blob/BlockExplorer.tsx` — remove username column/sort, swap all `*Username || shortHash(...)` displays for `shortHash(...)`, remove "username" sort option, drop username from search placeholders/filters.
- `src/components/blob/MempoolView.tsx` — replace `winnerUsername` / `fromUsername` displays with shortened address.
- `src/components/blob/MiningPanel.tsx` — show shortened address instead of `e.username`.
- `src/components/blob/NetworkView.tsx` — block tooltip uses shortened winner address.
- `src/components/blob/BridgeScreen.tsx` — drop `fromUsername` / `from_username` from outbound payloads.
- `src/components/blob/BlobRunGame.tsx` — drop `username` from the entry submission payload.

### Frontend — lib / hooks

- `src/lib/blob/constants.ts` — delete `USERNAME_RE` and `winnerUsername` from sample data.
- `src/lib/blob/explorer.ts` — drop `fromUsername` / `toUsername` / `winnerUsername` fields from row types and search matchers.
- `src/lib/blobRelay.ts` — drop username fields from `Block`, `Tx`, `Player`, `Entry` types and from Supabase row mappers; drop `username` from `registerPlayer` and entry submission payloads.
- `src/hooks/useWalletVault.ts` — remove `validateUsername`, `name` parameters, and the `resolve_username` RPC call. `createWallet(pass)` and `importWallet(secret, pass)` only.
- `src/lib/walletVault.ts` — drop `username` from `WalletPlain` and `WalletPublic`; stop persisting it.

### Edge functions

- `supabase/functions/register-player/index.ts` — accept `{address, publicKey, signature, timestamp}` only; sign payload becomes `register:{address}:{timestamp}`; insert without `username`.
- `supabase/functions/submit-entry/index.ts` — drop the `username` field, the uniqueness check, and the related error branches.
- `supabase/functions/seal-block/index.ts` — stop selecting/writing `username` and `winner_username`.
- `supabase/functions/submit-tx/index.ts` — stop accepting/writing `fromUsername` / `from_username`.
- `supabase/functions/bridge-mint/index.ts` — stop accepting/writing `from_username`.
- `supabase/functions/bridge-redeem/index.ts` — drop the `fromUsername: "Bridge"` field on broadcasts.
- `supabase/functions/request-access-code/index.ts` — left alone (X handle gate stays).

### Database migration

A single migration that:

1. Drops the trigger function reference to `winner_username` and recreates `update_player_on_block` without it.
2. Drops `public.resolve_username(text)`.
3. Recreates `public.get_block_leaderboard(bigint)` without the `username` column.
4. Drops the unique index `blob_players_username_lower_uniq` and constraint `blob_players_username_format`.
5. `ALTER TABLE` drops:
   - `blob_players.username`
   - `blob_chain.winner_username`
   - `blob_mempool.from_username`
   - `blob_entries.username`
   - `bridge_requests.from_username`

The X handle table (`access_requests.x_username`) is untouched.

## Display helper

A tiny `shortAddress(addr, head=6, tail=4)` helper is added to `src/lib/blob/explorer.ts` (or reused from existing `shortHash`) and used everywhere a username used to render. Each rendering site that previously was just text becomes a `<button>` styled as a chip that calls into the Explorer's existing account drawer (the BlockExplorer already has account selection — we expose a small `setSelectedAccount` route via URL hash `#acct=<address>` so non-explorer screens can deep-link).

## Risks / notes

- Dropping columns is irreversible. Any historical context (who won block #N by handle) is lost — only addresses remain.
- Existing wallets in browsers carry a `username` field in their encrypted vault; on next unlock it is simply ignored.
- The site title, README, and copy that mention "Username" / "@handle" are also scrubbed.

## Out of scope

- The X (Twitter) handle on the alpha access gate.
- The encrypted vault format (no migration needed; extra field becomes inert).
