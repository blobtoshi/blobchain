

## Fix: WBLOB balance flicker

### Root cause

In `RedeemPanel.tsx`, the balance-loading `useEffect` does `setSplBalance(null)` at the top of every run, then refetches. The effect depends on `active?.status`, so it re-runs on every poll status change (pending → verified → crediting → credited) — each time wiping the displayed balance to "…" before the new value arrives. That's the flicker.

### Fix

1. **Don't null the balance on refresh** — only clear it when the wallet/mint actually changes (disconnect or different mint). Keep the previous value visible while a fresh fetch is in flight.
2. **Refresh on meaningful events only** — refetch when:
   - wallet connects / `publicKey` changes
   - `splMintAddress` changes
   - a redemption transitions to `credited` (balance actually decreased)
   
   Drop the broad `active?.status` dependency that fires on every intermediate status.
3. **Add a light periodic refresh** (e.g. every 30s) so the balance stays current without polling-driven flicker.

### Files

- `src/components/blob/RedeemPanel.tsx` — split the balance effect: one for wallet/mint reset, one for fetching that preserves the prior value; trigger refetch on `credited` only, plus a 30s interval.

