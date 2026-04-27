## Phase 3 prep — Port the full BLOB site into the desktop app

Goal: the desktop app is a complete, standalone replacement for the website. If `blobchain.network` goes offline, users can still mine, send, view the chain, and use the bridge — as long as their chosen node and (for bridge) Supabase edge functions are reachable.

### Rename + restructure

- Rename folder `desktop-wallet/` → `desktop-app/`.
- Update `package.json` `name` to `blob-desktop-app`, package outputs `BlobApp-{linux,darwin,win}-x64`.
- Update Electron window title, menu label ("BLOB App"), and `index.html` `<title>`.
- Keep all existing wallet hooks (`useWallet`, `useNodeConfig`, `useNodeClient`, `secret.ts`, `vault.ts`, `history.ts`) — these stay as the durable foundation.

### Reuse vs. duplicate strategy

The desktop app already aliases `@web/*` → `../src/*`. We extend that approach so we **import the website's components directly** instead of forking them. This guarantees 1:1 visual parity and means future website changes flow into the desktop app automatically.

Components imported from `@web/`:
- `@web/components/blob/BlobRunGame`
- `@web/components/blob/MineHero`, `MiningPanel`
- `@web/components/blob/WalletScreen`, `SendTxForm`
- `@web/components/blob/BridgeScreen` (+ lazy `RedeemPanel`, `SolanaProvider`)
- `@web/components/blob/BlockExplorer`, `MempoolView`, `NetworkView`
- All `@web/components/ui/*` (shadcn) and lucide icons
- `@web/lib/blob/*`, `@web/lib/blobRelay`, `@web/lib/blobNodeClient`, `@web/hooks/useBlockchain`

### Design parity (1:1 with website)

To match the site exactly:

1. Copy `src/index.css`, `tailwind.config.ts`, `postcss.config.js`, `components.json` into `desktop-app/` (or import them via the Vite config with absolute paths).
2. Add Tailwind + PostCSS to `desktop-app/package.json` and wire up `tailwind.config.ts` to scan both `desktop-app/src/**` and `../src/**`.
3. Replace the current hand-rolled `styles.css` with the website's design tokens (HSL CSS vars, `glass`, `glass-hi`, `glass-pane`, `text-brand-gradient`, `label-eyebrow`, etc.).
4. Copy `src/assets/*` references via the existing Vite alias — no duplication.
5. Reuse the website's font stack and Toaster (`@/components/ui/toaster`, `sonner`).

### Relay strategy — node-first, Supabase as fallback for bridge only

`blobRelay.ts` already supports `mode = "node" | "supabase" | "auto"`. We force the desktop app into **node mode** for chain/mempool/entries so it does not depend on the website's Supabase being online for the core experience.

- Add a tiny shim `desktop-app/src/lib/relayBootstrap.ts` that, before any `@web` imports run, sets `import.meta.env.VITE_BLOB_RELAY_MODE = "node"` and `VITE_BLOB_NODE_URL = <user-chosen node>`. Imported once from `main.tsx`.
- Because env vars are baked at build time in Vite, we instead expose the chosen node via a small runtime override: extend `blobRelay.ts` with an exported `setRelayOverride({ mode, nodeUrl })` (one tiny addition to the website code) and call it from the desktop app on node-config change.
- Bridge edge functions (`bridge-config`, `bridge-mint`, `bridge-execute-mint`, `bridge-redeem`, `register-address`) **stay on Supabase** — they hold the bridge private key and Solana RPC and cannot run client-side. The bridge tab will show a clear "Bridge requires connection to blobchain.network services" banner and degrade gracefully when offline.

### App shell rewrite

Replace `desktop-app/src/App.tsx` with a thin orchestrator that mirrors `src/pages/Index.tsx`:

```text
┌─ Header (logo, balance pill, wallet menu, node status badge) ─┐
│  Nav: Mine · Wallet · Bridge · Explorer · Network             │
├──────────────────────────────────────────────────────────────┤
│  <screen content from @web components>                        │
└──────────────────────────────────────────────────────────────┘
```

Reuse the **exact JSX** from `src/pages/Index.tsx` by extracting it into a new shared component `src/pages/BlobChainApp.tsx` (move, no logic change), then import it from both `src/pages/Index.tsx` and `desktop-app/src/App.tsx`. Desktop wraps it with:

- `NodeSetupScreen` gate on first run (already built — keep).
- Native menu/keyboard shortcut bridge (already built — keep, extend with Mine/Bridge/Explorer/Network shortcuts).
- Idle auto-lock (already built — keep).
- A "Node" settings dialog accessible from the wallet menu (replaces the standalone Node tab; node is no longer one of the 5 main tabs — it lives in settings, matching the website's nav).

### Keep desktop-only features

- Node-first setup gate.
- Native menus + Cmd/Ctrl shortcuts: `Cmd+1..5` for Mine/Wallet/Bridge/Explorer/Network, `Cmd+L` lock, `Cmd+,` node settings.
- Idle auto-lock + secret wiping.
- Offline indicator + auto-reconnect via `navigator.onLine`.
- Local transaction history view (already built — promote into the wallet screen as a tab section, matching the website's wallet UX).

### Bridge wiring

`BridgeScreen` calls `Relay.fetchBridgeConfig()` etc., which always go to Supabase regardless of relay mode. This works as-is from the desktop app since the Supabase client is bundled. No code changes needed for the bridge other than:

- Surface a clear status: "Bridge services online" / "Bridge unavailable — check connection to blobchain.network".
- The `SolanaProvider` lazy chunk pulls in `@solana/wallet-adapter-react` + wallet UI; bundle size grows ~400KB. Acceptable for desktop.

### Dependencies to add to `desktop-app/package.json`

- `tailwindcss`, `postcss`, `autoprefixer`, `tailwindcss-animate`
- All shadcn-radix deps used by the imported components (`@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `sonner`, `@tanstack/react-query`, `react-router-dom` — needed because `Index.tsx` is rendered inside a `BrowserRouter` provider chain in `App.tsx`)
- `@supabase/supabase-js` (for bridge + edge functions)
- `@solana/web3.js`, `@solana/spl-token`, `@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`, `@solana/wallet-adapter-wallets`
- `react-hook-form`, `zod`, `@hookform/resolvers` (used by some web components)

Bundle will grow significantly; that's expected for a full-app port. Tree-shaking + lazy chunks (already present for bridge/Solana) keep the initial load reasonable.

### Files touched (high level)

**Renamed**: `desktop-wallet/` → `desktop-app/` (every file).

**New in `desktop-app/`**:
- `tailwind.config.ts`, `postcss.config.cjs` (or `.js`)
- `src/index.css` (re-exports website tokens + adds desktop chrome)
- `src/lib/relayBootstrap.ts`
- `src/screens/NodeSettingsDialog.tsx` (replaces the Node tab)

**Edited in `desktop-app/`**:
- `package.json` (name, deps, scripts)
- `vite.config.ts` (Tailwind, additional aliases)
- `tsconfig.json` (include shared paths)
- `electron/main.cjs`, `electron/preload.cjs` (menu items, app name)
- `src/App.tsx` (full shell rewrite, mounts shared `BlobChainApp`)
- `src/main.tsx` (import `relayBootstrap` first, mount providers: QueryClient, Tooltip, Toaster, BrowserRouter)
- Keep all existing hooks unchanged.

**Edited in website (`src/`)**:
- `src/lib/blobRelay.ts`: add `setRelayOverride({ mode, nodeUrl })` (~15 lines).
- `src/pages/Index.tsx`: extract body into `src/pages/BlobChainApp.tsx` (pure move + re-export, zero behavior change).

**Removed from `desktop-app/`**: the duplicated screens (`WalletTab`, `SendTab`, `NodeTab`, `HistoryTab`) — now covered by website components. `SetupScreen`, `UnlockScreen`, `NodeSetupScreen` stay (desktop-specific gates).

### Out of scope (Phase 3 follow-ups, not this task)

- Embedding a full node binary inside Electron so the app is fully self-contained even without an external node.
- Replacing Supabase bridge edge functions with a federated bridge (would let the app run with the website 100% offline).
- Auto-update (`electron-updater`).
- Code signing / notarization for macOS/Windows installers.

### Acceptance

After this work, launching `desktop-app` with the website fully offline should still let the user: pick a node → unlock → mine a block → send a tx → view the explorer → see the network view. Bridge will display an "unavailable" banner since it depends on Supabase. Visually the app is indistinguishable from the website apart from the desktop chrome (window frame, native menu, node settings dialog).
