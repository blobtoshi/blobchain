

## Fix: redemptions get stuck when switching tabs mid-flight

### Root cause

Two compounding issues:

1. **Tab content unmounts on switch.** `RedeemPanel` lives inside `<TabsContent value="reverse">` (Radix Tabs). When the user switches to BLOB→WBLOB, the panel unmounts — killing the polling interval, the active-redemption state, and the Solana provider. When they come back, `active` is `null`, the "Latest redemption" card is gone, and nothing is nudging the server.

2. **No auto-resume on mount.** The forward bridge already has logic to scan history and adopt any in-flight request as `active` (lines 130–137 of `BridgeScreen.tsx`). `RedeemPanel` is missing the equivalent.

The backend itself is fine — `bridge-redeem` re-runs `verifyAndCredit` via `EdgeRuntime.waitUntil` on every GET poll if the row is `pending` or `verified`. So the row isn't truly stuck; it just stops getting polled.

### Fix

**1. Auto-resume in-flight redemptions in `RedeemPanel`**
   - On mount and whenever history loads, find any redemption with status `pending`, `verified`, or `crediting`.
   - If `active` is `null` or already-finalized, adopt that in-flight row as the new `active`. This restores the "Latest redemption" card and restarts polling whenever the user returns to the tab.
   - Mirrors the forward-bridge effect at `BridgeScreen.tsx` lines 130–137.

**2. Keep tab content mounted (light touch)**
   - Add `forceMount` to `<TabsContent value="reverse">` (with `hidden` attribute when inactive), so `RedeemPanel` and its polling interval keep running even while the user is on the forward tab.
   - Note: this keeps the SolanaProvider alive too, but it's idle when not visible — no extra RPC calls beyond the existing 30s balance refresh, which we can also gate to "only when this tab is the active one" to be safe.

**3. Unstick the current pending burn**
   - On the next poll the backend will automatically re-run verifyAndCredit. To unstick the existing one immediately, we'll have the resumed `active` state trigger a poll on mount (it already does — `poll()` is called once before the interval starts).
   - No DB migration needed; the row will move forward naturally once polling resumes.

### Files

- `src/components/blob/RedeemPanel.tsx` — add an effect that adopts in-flight history rows as `active` when current `active` is null/done.
- `src/components/blob/BridgeScreen.tsx` — `forceMount` + `hidden` on the reverse `TabsContent` so the panel stays mounted across tab switches.

### Notes

- No backend changes needed.
- The stuck `pending` row will move forward on its own once the user reopens the bridge tab (the resumed poll triggers `verifyAndCredit` server-side).

