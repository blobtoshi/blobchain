# BLOB CHAIN

A proof-of-gaming blockchain. Players run a side-scrolling game; the highest verifiable score in each 120-second window seals the next block and mines $BLOB. Every wallet, miner, explorer, and bridge interaction in the React app talks to a real full node — no centralized chain backend.

- **Live site:** https://blobchain.network
- **Full node:** [`node/`](./node) — Node.js + SQLite, peer-to-peer over WebSocket
- **Desktop App:** [`desktop-app/`](./desktop-app) — Electron, connects to any node
- **Bridge (Solana ↔ BLOB):** Supabase Edge Functions, [`supabase/functions/bridge-*`](./supabase/functions)

---

## Architecture at a glance

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Website (this) │      │  Desktop App    │      │  Other clients  │
│  React + Vite   │      │  Electron       │      │                 │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │                        │                        │
         │  REST + WebSocket  (auto-failover via nodePool) │
         │                        │                        │
         ▼                        ▼                        ▼
   ┌─────────────────────────────────────────────────────────────┐
   │           Pool of BLOB CHAIN full nodes (gossip)            │
   │   node-a  ⇄  node-b  ⇄  node-c  ⇄  …  (depth-1 reorgs)     │
   └─────────────────────────────────────────────────────────────┘

        Bridge only (mint / redeem custody) lives off-chain:
        ┌──────────────────────────────────────────┐
        │  Supabase Edge Functions (bridge-*)      │
        │  → Solana SPL mint authority             │
        └──────────────────────────────────────────┘
```

Everything chain-related — blocks, mempool, mining entries, address registry, fee info, real-time gossip — flows through the node pool. The only piece using Supabase from the website is the Solana bridge, because minting / burning SPL tokens requires custodial keys.

---

## Repo layout

| Path                    | What it is                                                                 |
|-------------------------|-----------------------------------------------------------------------------|
| `src/`                  | React + Vite website (wallet, miner, explorer, bridge UI, network settings) |
| `src/lib/nodePool.ts`   | Shared multi-node failover + health probing                                 |
| `src/lib/blobRelay.ts`  | Thin client that routes calls through the active node                       |
| `node/`                 | Authoritative full node implementation (run this to host a peer)            |
| `src/server/`           | Editor-only mirror of `node/` (read-only — see `src/server/EDITOR_ONLY.md`) |
| `desktop-app/`          | Electron wallet that wraps the website code, bridge tab disabled            |
| `supabase/functions/`   | Bridge edge functions only (`bridge-config`, `bridge-mint`, `bridge-execute-mint`, `bridge-redeem`) |

---

## Run a node

A two-minute Docker setup is in [`node/README.md`](./node/README.md). For peering across machines see [`node/PEERS.md`](./node/PEERS.md).

```bash
cd node
docker compose up --build
# → two peered nodes on :8081 and :8082
```

---

## Desktop wallet

```bash
cd desktop-app
npm install
npm run dev:vite      # Vite dev server
npm run dev:electron  # Electron in another terminal
```

The desktop App stores its encrypted vault on disk and lets you manage multiple node URLs (auto / pinned). The bridge tab is intentionally hidden — bridging stays on the website.

---

## Bridge (the only Supabase exception)

Mint $BLOB on Solana from the BLOB chain, or redeem SPL $BLOB back to the chain. The flow:

1. Browser calls `bridge-mint` / `bridge-redeem` edge functions.
2. Edge function verifies the on-chain proof against the active node.
3. Edge function uses the Solana mint authority key to mint or burn SPL tokens.

Custodial keys can't live in a decentralized client, so this piece runs server-side. Required secrets are managed in Supabase.

---

## Tech stack

- **Frontend:** React 18, Vite 5, TypeScript, Tailwind, shadcn/ui, framer-motion, Solana wallet adapter
- **Node:** Node.js, Express, `ws`, `better-sqlite3`, `@noble/secp256k1`, `@noble/hashes`
- **Bridge:** Supabase Edge Functions (Deno), `@solana/web3.js`, `@solana/spl-token`
- **Desktop:** Electron 33

---

## Status — v0.1.0 (Live)

- ✅ Standalone full node with deterministic consensus
- ✅ Browser + desktop talk to nodes directly (no centralized chain backend)
- ✅ Multi-node failover, latency-based selection, user pinning
- ✅ Node ↔ node gossip with depth-1 reorgs
- ✅ Public node fleet live (`node.blobchain.network`, `node-eu`, `node-us`)
- ✅ Solana bridge (mint / redeem) live
- 🚧 Android/iOS application

## License

MIT
