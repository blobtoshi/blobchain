

## Fix: WBLOB → BLOB tab reloads page

### Root cause

`@solana/web3.js`, `@solana/spl-token`, and our `RedeemPanel` rely on Node.js globals (`Buffer`, `process`, `global`) that don't exist in browsers. There are no polyfills in `vite.config.ts` and no `buffer` package installed. When the lazy-loaded `SolanaProvider` chunk evaluates, `Buffer is not defined` is thrown — Vite then triggers a full page reload, which is the "loading… then reloads" you see.

### Fix

1. **Install polyfill packages**
   - `vite-plugin-node-polyfills` (handles `buffer`, `process`, `global`, `crypto` at bundle time)
   - `buffer` (so `Buffer.from(...)` in `RedeemPanel.tsx` resolves to the browser shim)

2. **Update `vite.config.ts`**
   - Add `nodePolyfills({ globals: { Buffer: true, global: true, process: true } })` to the plugins list.

3. **Update `RedeemPanel.tsx`**
   - Replace `Buffer.from(\`blob:${addr}\`, "utf8")` with `new TextEncoder().encode(\`blob:${addr}\`)` so the memo bytes don't depend on `Buffer` at all (defense in depth — the polyfill handles the SDK internals, this removes our direct dep).

4. **Verify**
   - Open the WBLOB → BLOB tab — Solana wallet button should mount, no reload.
   - No console errors about `Buffer`, `process`, or `global`.

### Files

- `package.json` (add deps)
- `vite.config.ts` (add plugin)
- `src/components/blob/RedeemPanel.tsx` (drop Buffer usage)

