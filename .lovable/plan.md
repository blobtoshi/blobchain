## Goal

Reframe the data model: connected wallets are just **addresses**, not "players". Rename the `blob_players` table and all related code to `blob_addresses`, removing player-centric language.

## Database changes (migration)

1. Rename table and view:
   - `ALTER TABLE public.blob_players RENAME TO blob_addresses;`
   - `DROP VIEW IF EXISTS public.blob_players_public;`
   - Recreate as `public.blob_addresses_public` (security_invoker, same columns) and `GRANT SELECT` to `anon, authenticated`.
2. Update the `update_player_on_block()` trigger function:
   - Rename to `public.update_address_on_block()`.
   - Body inserts/updates `public.blob_addresses` instead of `blob_players`.
   - Drop the old function after re-pointing the trigger on `blob_chain` to the new function.
3. Update `public.get_player_stats(...)` → keep behavior, rename to `public.get_address_stats(p_address text)` (returns same shape; "blocks_won / total_mined / best_score / avg_score / games_played" stay as column names since they describe the address's activity).

Note: existing column names like `blocks_won`, `best_score`, `games_played` are kept — they describe activity of the address, not a "player identity". No data is dropped; only the table/view/function names change.

## Edge function changes

- `supabase/functions/register-player/` → rename function to `register-address`. Update the upsert to `blob_addresses`. Update log prefixes and the file header comment.
- `supabase/functions/submit-entry/index.ts`: change `supa.from("blob_players")` → `supa.from("blob_addresses")`; rename `pErr` log message from "player upsert failed" → "address upsert failed".

## Frontend changes

- `src/lib/blobRelay.ts`:
  - Rename `registerPlayer` → `registerAddress` and call `supabase.functions.invoke("register-address", ...)`.
  - Rename `Player` type → `AddressRecord` (fields unchanged).
  - Rename `fetchPlayers` → `fetchAddresses`, querying `blob_addresses_public`.
- `src/hooks/useWalletVault.ts`: replace both `Relay.registerPlayer(...)` calls with `Relay.registerAddress(...)`.
- `src/components/blob/BlockExplorer.tsx`:
  - Replace `Relay.Player` with `Relay.AddressRecord`.
  - Rename local state `players` → `addresses`, `setPlayers` → `setAddresses`.
  - Replace `Relay.fetchPlayers()` with `Relay.fetchAddresses()`.
  - The "addresses" tab UI labels stay as-is (already uses "addresses" terminology).

## Out of scope

- Auto-generated `src/integrations/supabase/types.ts` will be regenerated automatically after the migration.
- Old historical migrations referencing `blob_players` are left untouched (they describe past state).

## Risk / compatibility

- Renaming `register-player` to `register-address`: any in-flight client still using the old endpoint name during the deploy window would 404 once. Acceptable since client code ships in the same change.
- The migration is structural-only; no row data is lost.