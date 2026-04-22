
## Remove "$" from "$BLOB" across the site

Replace every occurrence of `$BLOB` with `BLOB` across the codebase (158 matches in 11 files).

### Files to update
- `src/components/blob/NetworkView.tsx`
- `src/components/blob/SendTxForm.tsx`
- `src/components/blob/BridgeScreen.tsx`
- `src/components/blob/WalletScreen.tsx`
- `src/components/blob/MiningPanel.tsx`
- `src/components/blob/BlockExplorer.tsx`
- `src/components/blob/BlobRunGame.tsx`
- `src/components/blob/MineHero.tsx`
- `src/hooks/useBlockchain.ts`
- `src/pages/Index.tsx`
- Plus any other file in the 11-match set

### Approach
Use a single sed pass replacing the literal string `$BLOB` with `BLOB` across `src/**/*.{ts,tsx}`. This catches all UI labels, toast messages, suffixes in amount displays, and inline strings.

### Out of scope
- The token symbol `BLOB` itself (unchanged).
- Anything containing the word "blob" lowercase (e.g. variable names, "Blob Chain", "Blob Run").
- The wrapped-token label `WBLOB` recently added on the bridge screen.

### Verification
TypeScript build (`tsc --noEmit`) to confirm no syntax broke.
