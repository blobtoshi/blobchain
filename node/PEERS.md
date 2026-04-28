# Peering between BLOB CHAIN nodes

Each full node is also a WebSocket *client* of every URL in its `PEERS` env var. Connections are outbound only — you don't need to open any ports beyond the one your `/ws` server already listens on.

## Quick setup

1. Each operator publishes the public WebSocket URL of their node, e.g. `wss://node1.example.com/ws`.
2. On startup, set `PEERS` to a comma-separated list of *other* peers' URLs. Don't include yourself.

```bash
PEERS=wss://node1.example.com/ws,wss://node2.example.com/ws npm start
```

That's it. On connection the new node:

1. Receives the peer's `hello` (containing their tip height).
2. Pulls any blocks it's missing (with a 5-block back-window so it can heal a depth-1 reorg).
3. `subscribe`s to live gossip — new blocks, txs, and best-score entries propagate within ~1 second.

## What gets gossiped

| Event       | Source                  | Effect on receiving node                                                                                           |
|-------------|-------------------------|--------------------------------------------------------------------------------------------------------------------|
| `newBlock`  | Local sealer or peer    | Validated via `ingestBlock`. Append, replace (depth-1 reorg via lex-smaller hash), or reject with `needsResync`.   |
| `newTx`     | Wallet submit or peer   | Validated and stored in mempool. Re-broadcast iff new.                                                             |
| `newEntry`  | Wallet submit or peer   | Re-simulated and stored. Re-broadcast iff new best score.                                                          |
| `chainTip`  | Local sealer            | Lightweight tip update for non-subscribers.                                                                        |

## Reorg policy

This implements **depth-1 reorgs only**. If two peers seal the same height ~simultaneously, both blocks pass into `ingestBlock`; the one with the **lexicographically smaller hash** wins, and the loser's transactions are returned to the mempool atomically. Anything deeper (>1 block) is rejected and triggers a fresh range-pull from the peer.

## Operational notes

- Use `wss://` (TLS) in production. `ws://` is fine on a private docker network or for local dev.
- Reconnect uses exponential backoff capped at 30s.
- Stalled peers (no inbound traffic for 60s) are dropped and reconnected.
- `GET /peers` returns each peer's current state, latency, and remote height — handy for dashboards.
- Clients (website, desktop) have their own failover layer on top of this — even if one node loses peers, end users automatically move to the next healthy node in their pool.

## Two-node smoke test

```bash
cd node
docker compose up --build
# in another terminal:
curl -s localhost:8081/health | jq
curl -s localhost:8082/health | jq
curl -s localhost:8081/peers  | jq
```

Both `/health` responses should report `peers: 1`. Submit a mining entry to one and watch the other gain the same block within ~1 second.

## Bootstrapping a new node into an existing network

1. Pick at least one well-known peer URL from the published list.
2. Set `PEERS` to that URL (you can add more later).
3. Start the node — it will block-sync from the peer before catching up to live gossip.
4. Optionally publish your own URL so others can peer with you.

There is no permissioning. Any node speaking the protocol can join, and any client can choose to trust (or ignore) any node.
