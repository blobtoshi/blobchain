# BLOB CHAIN

A proof-of-gaming blockchain. Players run a side-scrolling game; the highest verifiable score in each 120-second window seals the next block and mines $BLOB. Every wallet, miner, explorer, and bridge interaction in the React app talks to a real full node — no centralized chain backend.

- **Live site:** https://blobchain.network
- **Full node:** [`node/`](./node) — Node.js + SQLite, peer-to-peer over WebSocket
- **Desktop wallet:** [`desktop-app/`](./desktop-app) — Electron, connects to any node
- **Bridge (Solana ↔ BLOB):** Supabase Edge Functions, [`supabase/functions/bridge-*`](./supabase/functions)

---

## Architecture at a glance

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Website (this) │      │  Desktop wallet │      │  Other clients  │
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

Everything chain-related — blocks, mempool, mining entries, address registry, fee info, real-time gossip — flows through the node pool. The only piece still using Supabase from the website is the Solana bridge, because minting / burning SPL tokens requires custodial keys.

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

## Run the website locally

```bash
npm install
npm run dev
```

Open http://localhost:8080. By default the website connects to the bundled public node list and auto-selects the lowest-latency healthy node.

### Point the website at your own node

Open the **Network** tab in the app and add your node URL under "Node connection." Or set a default at build time:

```bash
# .env.local
VITE_BLOB_NODE_URL=http://localhost:8080
```

If your node goes down, the website automatically fails over to the next healthy node in the pool. See [`node/README.md`](./node/README.md) for full details.

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

The desktop wallet stores its encrypted vault on disk and lets you manage multiple node URLs (auto / pinned). The bridge tab is intentionally hidden — bridging stays on the website.

---

## Bridge (the only Supabase exception)

Mint $BLOB on Solana from the BLOB chain, or redeem SPL $BLOB back to the chain. The flow:

1. Browser calls `bridge-mint` / `bridge-redeem` edge functions.
2. Edge function verifies the on-chain proof against the active node.
3. Edge function uses the Solana mint authority key to mint or burn SPL tokens.

Custodial keys can't live in a decentralized client, so this piece runs server-side. Required secrets are managed in Lovable Cloud.

---

## Tech stack

- **Frontend:** React 18, Vite 5, TypeScript, Tailwind, shadcn/ui, framer-motion, Solana wallet adapter
- **Node:** Node.js, Express, `ws`, `better-sqlite3`, `@noble/secp256k1`, `@noble/hashes`
- **Bridge:** Supabase Edge Functions (Deno), `@solana/web3.js`, `@solana/spl-token`
- **Desktop:** Electron 33

---

## Status

- ✅ Standalone full node with deterministic consensus
- ✅ Browser + desktop talk to nodes directly (no Supabase chain backend)
- ✅ Multi-node failover, latency-based selection, user pinning
- ✅ Node ↔ node gossip with depth-1 reorgs
- ✅ Bridge isolated to a single Supabase exception
- ⏳ Public node fleet bootstrap (placeholder URLs in `nodePool` until real ones are live)
- ⏳ Alpha access gate — kept on Supabase for now, removed at launch
