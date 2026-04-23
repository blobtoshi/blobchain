
## Fix: "SPL" label should read "WBLOB" in forward bridge summary

### Change

In `src/components/blob/BridgeScreen.tsx`, the "You receive on Solana" row in the summary card displays the receive amount with the unit `SPL`. Replace that unit string with `WBLOB` to match the token's user-facing name.

### Files

- `src/components/blob/BridgeScreen.tsx` — change the trailing `SPL` label on the "You receive on Solana" line to `WBLOB`.
