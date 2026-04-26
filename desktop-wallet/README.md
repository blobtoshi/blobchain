# BLOB Wallet — Desktop

A standalone GUI wallet for BLOB CHAIN. Connects directly to any full node over REST + WebSocket, so you can manage funds and send transactions even if the website is offline.

## Features

- Create or import a 12-word seed phrase
- Encrypted on-disk vault (AES-GCM, PBKDF2 600k)
- Send transactions with slow / normal / fast / custom fee presets
- Switch between multiple node URLs
- Live tip / mempool status

## Develop

```bash
cd desktop-wallet
npm install
# Terminal A: Vite dev server
VITE_DEV_SERVER_URL=http://localhost:5180 npm run dev:vite
# Terminal B: Electron
VITE_DEV_SERVER_URL=http://localhost:5180 npm run dev:electron
```

## Package

```bash
npm run package:linux   # → electron-release/BlobWallet-linux-x64/
npm run package:mac     # cross-compiled .app
npm run package:win     # cross-compiled .exe folder
```
