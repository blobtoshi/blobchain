# Standalone GUI Wallet (Desktop App)

A self-contained desktop wallet so users can manage their BLOB CHAIN wallet and send transactions even if the website is offline. It talks directly to any full node over REST + WebSocket — no website, no Supabase required.

## What you get

A small Electron app with three tabs:

1. **Wallet** — create / import (12-word seed or private key) / unlock / lock. Shows address, balance, copy / export controls.
2. **Send** — recipient, amount, memo, fee preset (slow/normal/fast/custom). Same signing + canonical-bytes logic as the website, so transactions are accepted by any node.
3. **Node** — set the node URL (defaults to `http://localhost:9090`), see live status (connecting / syncing / open / closed), tip height, mempool size. Save multiple node URLs and switch between them.

The wallet vault is stored encrypted on disk (AES-GCM, PBKDF2 600k iters) — same format as the web vault, just persisted via Electron instead of `localStorage`. Works fully offline for signing; only broadcasting needs a reachable node.

## Technical details

**Stack**
- Electron + Vite + React (separate from the main app, in a new `desktop-wallet/` folder so it doesn't pollute the website build).
- Reuses `src/lib/blob/crypto.ts`, `src/lib/blob/fees.ts`, `src/lib/blob/constants.ts`, `src/lib/blob/chain.ts`, `src/lib/blobNodeClient.ts`, and `src/lib/wsProtocol.ts` via path aliases — no duplicated consensus logic.
- `vite.config.ts` for the desktop app sets `base: './'` (required for Electron `file://` loading).
- Main process: `desktop-wallet/electron/main.cjs` (`.cjs` because root `package.json` has `"type": "module"`), `contextIsolation: true`, `nodeIntegration: false`.
- Preload exposes a tiny `vaultBridge` API: `readVault()`, `writeVault(json)`, `clearVault()` — backed by an encrypted file in Electron's `app.getPath('userData')`. Same on-disk JSON shape as the existing web vault so users can paste their mnemonic to recover.

**Networking**
- Uses `BlobNodeClient` directly against the user-supplied node URL (REST for cold reads, WS `/ws` for live tip + ack'd `submitTx`).
- Balance is computed locally with `calcBalance(address, chain, mempool)` after fetching the chain from the node — identical to the website.
- No Supabase calls, no website dependency.

**Build & packaging**
- Dev: `cd desktop-wallet && npm run dev` (Vite dev server + Electron).
- Package with `@electron/packager` (not electron-builder — fails in this sandbox). Outputs go to `desktop-wallet/electron-release/` and are archived to `/mnt/documents/` as:
  - `BlobWallet-linux-x64.tar.gz`
  - `BlobWallet-darwin-x64.zip` (macOS, cross-compiled)
  - `BlobWallet-win32-x64.zip` (Windows, cross-compiled)
- Note: `.dmg` / `.exe` installers / `.AppImage` are not buildable here; users unzip and run the binary inside.

**Out of scope (for this first cut)**
- Mining (the runner game). Wallet-only.
- Bridge to Solana (depends on Supabase edge functions). Wallet-only.
- Auto-update. Users re-download new builds.

## Open questions

1. Default node URL to ship with — `http://localhost:9090`, or your public node, or blank (force user to enter)?
2. OK to skip mining + bridge in v1, or do you want those too (bridge would still need internet to the website's edge functions)?
