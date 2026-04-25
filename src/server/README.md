# BLOB CHAIN — Full Node

A standalone Node.js implementation of the BLOB CHAIN consensus rules.
Runs the same 120-second weighted-lottery block sealer as the current
Supabase edge function, persists state in SQLite, and gossips new blocks /
transactions / mining entries over WebSocket.

This is **Phase 1** of the decentralization migration — the browser app is
not yet wired to it. Once a node is verified locally, Phase 2 will add a
light-client hook (`useLightChain.ts`) and switch the relay over.

---

## Quick start (local)

```bash
cd node
npm install
npm run dev
```

The node listens on `http://localhost:8080` (HTTP + WebSocket on `/ws`).

```bash
curl http://localhost:8080/health
# → { "ok": true, "height": 0, "tipHash": "412c…", "peers": 0, ... }
```

### Environment variables

| Var       | Default               | Purpose                           |
|-----------|-----------------------|-----------------------------------|
| `PORT`    | `8080`                | HTTP / WS port                    |
| `DB_PATH` | `./data/blobchain.db` | SQLite file (auto-created)        |
| `NODE_ID` | random UUID           | Stable identifier across restarts |

---

## HTTP endpoints

| Method | Path             | Description                          |
|--------|------------------|--------------------------------------|
| GET    | `/health`        | Liveness + tip summary + peer count  |
| GET    | `/chain/tip`     | `{ height, hash, totalSupply, timestamp }` |
| GET    | `/blocks?from=N&limit=M` | Range of blocks (max 500)    |
| GET    | `/mempool`       | All pending transactions             |
| GET    | `/fee-info`      | Recommended / minimum fee rate       |

## WebSocket protocol

Connect: `ws://localhost:8080/ws`

On connect the server immediately sends:

```json
{ "type": "hello", "nodeId": "...", "version": "1.0.0", "chainTip": { ... } }
```

Client → Server messages (see `wsProtocol.ts`):

- `{ "type": "subscribe" }` — receive future blocks/txs/entries
- `{ "type": "submitTx", "tx": { ... } }`
- `{ "type": "submitEntry", "entry": { ... } }`
- `{ "type": "getChainTip" }`
- `{ "type": "getBlocks", "fromHeight": 1, "limit": 100 }`
- `{ "type": "getMempool" }`
- `{ "type": "ping", "t": 12345 }`

Server → Client messages:

- `{ "type": "hello", ... }`
- `{ "type": "ack", "ref": "...", "data": { ... } }`
- `{ "type": "error", "ref": "...", "message": "..." }`
- `{ "type": "newBlock", "block": { ... } }`
- `{ "type": "newTx", "tx": { ... } }`
- `{ "type": "newEntry", "entry": { ... } }`
- `{ "type": "chainTip", "tip": { ... } }`
- `{ "type": "blocksRange", "blocks": [ ... ] }`
- `{ "type": "mempool", "txs": [ ... ] }`
- `{ "type": "pong", "t": 12345 }`

---

## Sanity test with `wscat`

```bash
npx wscat -c ws://localhost:8080/ws
> {"type":"subscribe"}
< {"type":"ack","ref":"subscribe"}
> {"type":"getChainTip"}
< {"type":"chainTip","tip":{"height":0,"hash":"412c…",…}}
```

Submitting a real signed tx or entry requires the same payload format the
edge functions accept (`submit-tx`, `submit-entry`). The browser already
produces these payloads — Phase 2 will route them here over WS.

---

## Consensus invariants

The full node enforces the **same** rules as `supabase/functions/seal-block`:

- 120-second block window
- Weighted lottery winner selection (entries sorted by address for determinism, `Mulberry32` PRNG seeded from height)
- Halving every 1,000,000 blocks; initial reward 10 $BLOB; hard cap 20,000,000 $BLOB
- Block hash = `sha256("height|prev|ts|winner|score|reward|seed|txCount")`
- Proof-of-gaming: a block with **zero verified mining entries cannot be sealed** — it stays open until a player submits a score
- Transaction validation: secp256k1 sig over `from→to:amount@ts|fr=feeRate|m=memo`, P2PKH address derivation from compressed pubkey, congestion-adjusted minimum fee rate, balance check
- Mining entry validation: deterministic re-simulation of the submitted input trace (`_simulator.ts`) — replay must terminate at the same frame and score

If any of these drift from the edge function, the two will produce
different chains. Keep `node/lib/consensus.ts` and the simulator copy
byte-for-byte synced with the edge versions.

---

## Deploying multiple nodes (later)

For now, run a single local node. When you're ready to deploy four
always-online nodes, any of these work cleanly with this code:

- **Fly.io** — `fly launch` from `node/`, mount a volume at `/data`
- **Railway** — set `DB_PATH=/data/blobchain.db` with a volume
- **Render** — Web Service, persistent disk
- **Plain VPS** — `pm2 start "npm start"` behind nginx with a TLS cert

Phase 2 will add node↔node peering so the four servers gossip blocks to
each other and converge on a single chain.

---

## What's intentionally *not* here yet

- Solana bridge (`bridge-mint`, `bridge-redeem`) — staying on Supabase for now, will be ported in Phase 3.
- Access-code / locked gate — kept on Supabase; you mentioned it gets removed at launch.
- Browser light-client integration — Phase 2.
- Node↔node peering / chain reorg handling — Phase 2.
