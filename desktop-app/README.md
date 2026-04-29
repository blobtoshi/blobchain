# BLOB Wallet — Desktop (v1.0)

A standalone Electron wallet for BLOB CHAIN. Connects directly to any full node over REST + WebSocket, so you can manage funds and send transactions even when the website is offline.

The desktop app is **node-only**. The Solana bridge is intentionally not included here — bridging happens on the website.

## Features

- Create or import a 12-word seed phrase
- Encrypted on-disk vault (AES-GCM, PBKDF2 600k)
- Send transactions with slow / normal / fast / custom fee presets
- Multi-node connection pool with automatic failover and latency-based selection
- Pin a specific node, or let the app auto-pick the fastest healthy one
- Add and remove custom node URLs from the in-app Node settings
- Live tip / mempool status, transaction history, mining entries

## Develop

```bash
cd desktop-app
npm install
# Terminal A: Vite dev server
npm run dev:vite
# Terminal B: Electron
npm run dev:electron
```

The Electron main process exposes two IPC bridges to the renderer:

- `vaultBridge` — encrypted seed vault on disk
- `nodeConfigBridge` — persistent node list (`{ pinned, custom: string[] }`)

## Package

```bash
npm run package:linux   # → electron-release/BlobApp-linux-x64/
npm run package:mac     # cross-compiled .app
npm run package:win     # cross-compiled .exe folder
```

## Connecting to a node

By default the wallet uses the bundled public node list and auto-selects the lowest-latency one. To pin your own node, open **Node settings** in the app and add its URL (e.g. `http://localhost:8080` or `wss://my-node.example.com`).

To run a node yourself, see [`../node/README.md`](../node/README.md).

## Architecture note

The desktop renderer reuses the website's React tree (`src/pages/BlobChainApp.tsx`) with `disableBridge={true}`, so wallet, miner, explorer, network, and history all stay 1:1 with the site. The only thing it strips is the Bridge tab.
