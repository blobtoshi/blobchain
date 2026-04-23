

## Fix: Solana RPC 403 — public mainnet endpoint blocks browsers

### Root cause

`SolanaProvider` defaults to `https://api.mainnet-beta.solana.com`. That endpoint blocks browser-origin RPC calls (especially `getAccountInfo` / `getMint` / `getTokenAccountBalance`) with HTTP 403 — the exact error you're seeing on `getMint(connection, 8e5J22…)`. We need a browser-friendly RPC for the WBLOB → BLOB tab to function at all.

### Fix

1. **Move the Solana RPC URL server-side**
   - Extend `bridge-config` edge function to also return `solanaRpcUrl`, sourced from a new Supabase secret **`SOLANA_RPC_URL`**. This keeps the (often paid / keyed) RPC URL out of the client bundle and lets us rotate without redeploying.
   - Frontend already calls `bridge-config` — `BridgeScreen.tsx` will pass the returned URL down to `SolanaProvider` instead of using the hardcoded default.

2. **`SolanaProvider` accepts an `endpoint` prop**
   - Replaces the current `import.meta.env.VITE_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com"` fallback chain.
   - Falls back to a working public endpoint (`https://solana-rpc.publicnode.com`, which permits browser CORS) if no secret is configured yet — so the tab still works out of the box, just rate-limited.

3. **Defensive UX in `RedeemPanel`**
   - Catch RPC errors from `getMint` / `getTokenAccountBalance` and surface a clear message ("Solana RPC unavailable — try again or configure SOLANA_RPC_URL") instead of a raw 403 dump.

4. **Add a secret prompt**
   - Ask the user (you) for **`SOLANA_RPC_URL`** — a Helius / QuickNode / Alchemy / Triton mainnet HTTPS RPC URL with browser CORS enabled. Optional but strongly recommended; without it we'll use the public node fallback.

### Required from you

- **`SOLANA_RPC_URL`** (optional but recommended). Free tiers from Helius or QuickNode work fine; needs to allow browser origins. If you skip it, the bridge will use `solana-rpc.publicnode.com` which is rate-limited but unblocked.

### Files

- `supabase/functions/bridge-config/index.ts` — return `solanaRpcUrl`.
- `src/lib/blobRelay.ts` — extend `BridgeConfig` type + `fetchBridgeConfig`.
- `src/components/blob/SolanaProvider.tsx` — accept `endpoint` prop, drop hardcoded default.
- `src/components/blob/BridgeScreen.tsx` — wire RPC URL from config into provider.
- `src/components/blob/RedeemPanel.tsx` — wrap mint/balance calls with friendlier error.

