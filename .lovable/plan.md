# Bridge keypair pinned at genesis (with chain reset)

## Summary

Generate a fresh secp256k1 keypair for the bridge, bake the **public address** into a new `GENESIS` block (chain reset), update the secret with the new **private key** once, and remove the address inconsistency across the codebase. The on-chain bridge logic then never needs DB or secret edits again — it only needs the edge function process running, which your future 4+ full nodes will provide.

## What changes

### 1. Generate the bridge keypair (one-time, in build mode)

- Run a one-off Node script via `code--exec` that uses the project's existing `@noble/secp256k1` + `@scure/base` deps to mint a fresh `{ mnemonic, privateKey, publicKey, address }`.
- Print **mnemonic + privateKey + address** in chat so you can copy them once.
- I will **only** keep the `address` (and `publicKey`) in the codebase; I will not commit the private key or mnemonic.
- You then update the `BRIDGE_BLOB_PRIVATE_KEY` secret with the new private key (last time you ever touch it).

### 2. Reset & extend the genesis block

In `src/lib/blob/constants.ts`:
- Replace the current `BRIDGE_ADDRESS = "13mEv2j…"` with the new generated address.
- Bump `GENESIS_TIME_MS` to a new "now" so the chain restarts cleanly from height 0.
- Recompute / update `GENESIS.hash` (deterministic from genesis fields).
- Add `bridgeAddress` and `bridgePublicKey` fields to the `GENESIS` block so they are part of consensus.

### 3. Single source of truth for `BRIDGE_ADDRESS`

Today it's hardcoded in 4 places, with two different values. Fix:
- `src/lib/blob/constants.ts` — canonical client value.
- `supabase/functions/bridge-config/index.ts` — replace constant.
- `supabase/functions/bridge-mint/index.ts` — replace constant.
- `supabase/functions/bridge-redeem/index.ts` — replace constant. Keep its existing `derivedAddr !== BRIDGE_ADDRESS` self-check — it now guarantees on every call that the loaded private-key secret still matches the genesis-pinned address.

(Edge functions can't `import` from `src/`, so they keep their own copy of the constant. The `derivedAddr` self-check + a code comment "MUST match GENESIS.bridgeAddress" is the safety net.)

### 4. Reset on-chain state

Because genesis changes, all current chain rows are invalid. Migrations:
- `TRUNCATE` `blob_chain`, `blob_entries`, `blob_players` (and any related tables).
- This is acceptable per your confirmation.

### 5. Surface in UI (small)

In `NetworkView.tsx` (Consensus / supply card), add a row: **Bridge address** with the genesis-pinned value and a 🔒 icon, so anyone can verify it's locked at genesis.

## Security model after this change

- **BLOB side bridge key**: pinned at genesis, address verifiable by anyone, private key held only by the node operator (you / your 4+ full nodes). Lose the secret → bridge stops; can't be silently swapped.
- **Solana mint authority**: unchanged. Still a server secret. (You confirmed this is fine.)
- **No DB writes ever needed for the bridge** to function correctly.

## Files touched

- `src/lib/blob/constants.ts`
- `src/components/blob/NetworkView.tsx` (small addition)
- `supabase/functions/bridge-config/index.ts`
- `supabase/functions/bridge-mint/index.ts`
- `supabase/functions/bridge-redeem/index.ts`
- New migration: `supabase/migrations/<ts>_reset_chain_for_genesis.sql`

## What I need from you to proceed

Confirm: I'll generate the keypair via `code--exec`, paste the **mnemonic + private key + address** into chat **once** (you save them immediately), then commit only the address. OK to proceed?
