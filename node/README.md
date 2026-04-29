# BLOB CHAIN — Full Node

The authoritative implementation of the BLOB CHAIN consensus rules. Standalone Node.js process: 120-second weighted-lottery block sealer, SQLite persistence, WebSocket gossip with other nodes, REST + WebSocket API for clients (website, desktop wallet, anything else).

Every browser, desktop, or third-party client talks to a node like this one — there is no centralized chain backend any more.

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

---

## Run with Docker

```bash
cd node
docker compose up --build
```


For a single container:

```bash
docker build -t blobchain-node .
docker run -p 8080:8080 -v blobchain-data:/data \
  -e DB_PATH=/data/blobchain.db \
  -e PEERS=wss://node-a.example.com/ws,wss://node-b.example.com/ws \
  blobchain-node
```

---

## Environment variables

| Var       | Default               | Purpose                                                       |
|-----------|-----------------------|---------------------------------------------------------------|
| `PORT`    | `8080`                | HTTP / WebSocket port                                         |
| `DB_PATH` | `./data/blobchain.db` | SQLite file (auto-created)                                    |
| `NODE_ID` | random UUID           | Stable identifier across restarts                             |
| `PEERS`   | *(empty)*             | Comma-separated WebSocket URLs of other nodes (see PEERS.md)  |
| `UPDATE_REPO` | `blobchain/blobchain` | GitHub `owner/repo` to check for new releases             |
| `UPDATE_BRANCH` | `main`              | Branch tracked for the update check                         |
| `UPDATE_CHECK` | `1`                  | Set to `0` to disable the startup update check              |
| `UPDATE_CHECK_INTERVAL_MS` | `21600000` | Re-check cadence (default 6h)                       |

### Update notifications

On startup (and every 6h after), the node compares its local git commit against the configured GitHub repo/branch. If a newer commit exists upstream, a banner is printed in the logs prompting the operator to run `git pull && npm install` (or `docker compose pull && docker compose up -d --build`). The check is best-effort and silently skipped if the node isn't a git checkout or GitHub is unreachable.

---

## Connecting clients

### Website
The React app at `src/` ships with a multi-node pool (`src/lib/nodePool.ts`). It probes a list of bundled URLs + any user-added URLs in parallel, picks the lowest-latency healthy one, and fails over automatically when a node dies. To make it default to your node at build time:

```bash
# .env.local in the website project
VITE_BLOB_NODE_URL=http://localhost:8080
```

End users don't need to set anything — they can add and pin nodes from the **Network** tab in the app.

### Desktop wallet
`desktop-app/` ships with the same pool. Manage URLs from the in-app Node settings. The desktop wallet is node-only — it has no Supabase code path at all.

### Other clients
The HTTP and WebSocket protocols below are stable. Anything that can speak HTTP + JSON over WS can be a client.

---

## HTTP endpoints

| Method | Path                       | Description                                                  |
|--------|----------------------------|--------------------------------------------------------------|
| GET    | `/health`                  | Liveness + tip summary + peer count                          |
| GET    | `/chain/tip`               | `{ height, hash, totalSupply, timestamp }` — `If-None-Match` aware |
| GET    | `/blocks?from=N&limit=M`   | Range of blocks (max 500)                                    |
| GET    | `/blocks/:height`          | Single immutable block                                       |
| GET    | `/mempool`                 | All pending transactions                                     |
| GET    | `/mempool?since=<ts>`      | Delta sync — only txs newer than `<ts>` (ms)                 |
| GET    | `/fee-info`                | Recommended / minimum fee rate                               |
| GET    | `/peers`                   | Peer list with state, latency, remote height                 |

---

## WebSocket protocol

Connect: `ws://localhost:8080/ws` (use `wss://` in production).

Server immediately sends:
```json
{ "type": "hello", "nodeId": "...", "version": "1.0.0", "chainTip": { ... } }
```

Client → Server (see `wsProtocol.ts`):
- `{ "type": "subscribe" }` — receive future blocks/txs/entries
- `{ "type": "submitTx", "tx": { ... } }`
- `{ "type": "submitEntry", "entry": { ... } }`
- `{ "type": "getChainTip" }`
- `{ "type": "getBlocks", "fromHeight": 1, "limit": 100 }`
- `{ "type": "getMempool" }`
- `{ "type": "ping", "t": 12345 }`

Server → Client:
- `hello`, `ack`, `error`
- `newBlock`, `newTx`, `newEntry`, `chainTip`
- `blocksRange`, `mempool`, `pong`

**Abuse guard:** 5 malformed/invalid messages on a single socket → connection terminated.

---

## Sanity test with `wscat`

```bash
npx wscat -c ws://localhost:8080/ws
> {"type":"subscribe"}
< {"type":"ack","ref":"subscribe"}
> {"type":"getChainTip"}
< {"type":"chainTip","tip":{"height":0,"hash":"412c…",…}}
```

---

## Consensus invariants

The node is the only place the chain rules live now. They are:

- 120-second block window
- Weighted lottery winner selection (entries sorted by address for determinism, `Mulberry32` PRNG seeded from height)
- Halving every 1,000,000 blocks; initial reward 10 $BLOB; hard cap 20,000,000 $BLOB
- Block hash = `sha256("height|prev|ts|winner|score|reward|seed|txCount")`
- Proof-of-gaming: a block with **zero verified mining entries cannot be sealed** — it stays open until a player submits a score
- Transaction validation: secp256k1 sig over `from→to:amount@ts|fr=feeRate|m=memo`, P2PKH address derivation from compressed pubkey, congestion-adjusted minimum fee rate, balance check
- Mining entry validation: deterministic re-simulation of the submitted input trace (`lib/simulator.ts`) — replay must terminate at the same frame and score

If you fork the node, keep these rules byte-for-byte identical or your chain will diverge from the rest of the network.

---

## Peering

Each node is also a WebSocket *client* of every URL in `PEERS`. New blocks, transactions, and best-score entries gossip across the mesh in ~1 second. Depth-1 reorgs are resolved by lexicographically smaller hash. Anything deeper triggers a fresh range-pull.

Two-node smoke test:

```bash
docker compose up --build
curl -s localhost:8081/health   # peers: 1
curl -s localhost:8082/health   # peers: 1
curl -s localhost:8081/peers
```

Full protocol, reorg policy, and operational notes: [`PEERS.md`](./PEERS.md).

---

## Deployment options

Anything that can run a long-lived Node.js process with a persistent volume works:

- **Docker** anywhere — see `Dockerfile` and `docker-compose.yml`
- **Fly.io** — `fly launch` from `node/`, mount a volume at `/data`
- **Railway** — set `DB_PATH=/data/blobchain.db` with a persistent volume
- **Render** — Web Service + persistent disk
- **Plain VPS** — `pm2 start "npm start"` behind nginx with a TLS cert

Always serve `/ws` over `wss://` in production.

---

## What this node does *not* do

- **Solana bridge.** Mint / redeem requires custodial keys and lives in edge functions on the website side. The node never touches Solana. (`lib/bridge.ts` is a stub.)

Everything else — chain reads, mempool, mining, address registry, real-time updates — happens here.

---

## License

MIT
