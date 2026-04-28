# Phase 3 — Decentralize for real

Right now the full node is a great single-process server: it seals blocks, validates txs/entries, and can be the browser/desktop relay. But three things still tie us to Lovable Cloud:

1. **There's only ever one node.** No node↔node peering, so a second node can't join the network.
2. **Entries, addresses, and the bridge** still depend on Supabase tables/edge functions.
3. **Deployment** is undocumented — no bootstrap peer list, no Dockerfile, no public node URLs to ship in `BUNDLED_NODES`.

Phase 3 closes all three. After this phase, the network can run on N independent self-hosted nodes with zero Supabase dependency for consensus or the bridge — Supabase only stays for the access-code gate, which gets removed at launch anyway.

---

## 1. Node↔node peering (the big one)

Add an outbound peer manager to the full node so multiple nodes converge on the same chain.

**`node/lib/peers.ts` (new)**

- `PeerManager` class. Inputs: list of bootstrap peer URLs (env `PEERS=ws://a,ws://b,...`).
- For each peer, maintain a long-lived **outbound** WebSocket using the existing `wsProtocol` (peers are just clients of each other). Auto-reconnect with backoff (reuse the pattern from `BlobNodeClient`).
- On (re)connect to a peer:
  1. Read peer's `hello` to learn its tip.
  2. If peer's height > ours → page through `getBlocks` until caught up (re-validate every block before insert; see §1b).
  3. If our height > peer's → that peer will pull from us via its own outbound.
  4. Send `subscribe` so we receive their gossip.
  5. Forward their `newBlock` / `newTx` / `newEntry` into the local pipeline (§1b).
- Keep peer health: ping every 20s; if no message in 60s, drop+reconnect.
- Expose `peers.count()`, `peers.list()` for `/health` and a new `/peers` endpoint.

**`node/lib/ingest.ts` (new) — the single chokepoint for "incoming things from outside"**

Today `full-node.ts` validates+inserts tx/entry inline in the WS handler. Refactor those inserts into pure functions so both client subscriptions *and* peer gossip go through them:

- `ingestTx(d, tx) → { ok, dedup? }` — validates, inserts (INSERT OR IGNORE), returns whether it was new.
- `ingestEntry(d, entry) → { ok, isNewBest }` — same pattern.
- `ingestBlock(d, block) → { ok, error? }` — **new**. Validates the block from a peer:
  - height = local tip + 1, `previousHash` matches our tip's hash;
  - timestamp ≥ prev + 120s;
  - `seed` matches `seedForHeight(height)`;
  - re-derive `pickWinner` from supplied `miningEntries` and assert it matches `block.winner`;
  - recompute `computeBlockHash` and assert it equals `block.hash`;
  - cross-check `reward` against `getRewardForHeight + feeTotal`.
  - If valid: insert block + remove its txs from local mempool atomically (same SQLite tx as the sealer).
  - Re-broadcast to local subscribers (`gossip.broadcast({type:"newBlock"})`) so wallets connected to *this* node see it instantly.
- `ingestBlock` returns `{ ok:false, error:"bad-prev" }` if `previousHash` doesn't line up. The peer manager treats that as "we're behind or forked" → triggers a `getBlocks(from = tip - 5)` resync from that peer to catch up.

`full-node.ts` then calls `ingestTx/Entry/Block` from both the WS client handler and the peer-message handler. Single source of truth.

**Sealer race-resolution**

Two nodes will sometimes seal block N at nearly the same instant. Tie-break deterministically:
- When `ingestBlock` arrives for height N and we *also* just sealed our own block N locally, keep the block with the **lexicographically smaller hash**. If the peer's wins, we delete our local block N and re-apply theirs (atomic SQLite tx). The losing block's txs go back into the mempool.
- This is the simplest possible reorg: depth-1 only. Good enough for a 120s block time with a few peers.

**`/peers` endpoint** in `full-node.ts` returns `[{ url, connectedSince, height, latencyMs }]` for ops visibility.

## 1b. Entries REST + per-height endpoint

`fetchEntries` in `blobRelay.ts` currently returns `[]` in node mode (relies on WS gossip). For the explorer's "block leaderboard" view to work on cold load, add:

- **`GET /blocks/:height/entries`** — returns full entries for a sealed block (already in `block.miningEntries`, but the explorer wants score/address pairs without parsing the whole block payload).
- **`GET /entries?height=N`** — current open-block entries (from the `entries` table where `block_height = activeHeight`).

Wire `BlobNodeClient.fetchEntries(height)` and update the `node` branch of `Relay.fetchEntries`.

---

## 2. Port the Solana bridge to the full node

The bridge is the last consensus-adjacent piece on Lovable Cloud. Port it 1:1 so a node operator can run a fully sovereign instance.

**Forward bridge (BLOB → wBLOB on Solana)** — `node/lib/bridge.ts` + new HTTP routes:

- `POST /bridge/mint` — body `{ blob_tx_id, sol_address, amount, from_address }`. Same logic as `bridge-mint` edge function: verify the BLOB tx is in a sealed block to the bridge address with matching amount, record a `bridge_requests` row (new SQLite table), return status. Idempotent on `blob_tx_id`.
- `GET /bridge/mint?blob_tx_id=…` — poll status.
- Internal worker (interval, 5s): pick `pending` requests, call Solana RPC to mint SPL tokens to `sol_address` using `BRIDGE_BLOB_PRIVATE_KEY` + `SOLANA_MINT_AUTHORITY_SECRET_KEY`, mark `minted` on success.

**Reverse bridge (wBLOB → BLOB)** — same shape:
- `POST /bridge/redeem` — verify the Solana burn signature, record a `bridge_redeems` row, then enqueue an internal BLOB tx from the bridge wallet to `blob_address` (signed locally with `BRIDGE_BLOB_PRIVATE_KEY`) and submit it to our own mempool.

**`GET /bridge/config`** — returns `{ bridgeAddress, splMintAddress, solanaRpcUrl }` so wallets know where to send.

**Schema additions** in `node/lib/db.ts`:

```sql
CREATE TABLE IF NOT EXISTS bridge_requests (
  blob_tx_id TEXT PRIMARY KEY,
  from_address TEXT NOT NULL,
  sol_address TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|minting|minted|failed
  sol_signature TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  minted_at INTEGER
);
CREATE TABLE IF NOT EXISTS bridge_redeems (
  sol_signature TEXT PRIMARY KEY,
  blob_address TEXT NOT NULL,
  amount REAL NOT NULL,
  credit_amount REAL,
  bridge_fee REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  blob_tx_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  credited_at INTEGER
);
```

**Env vars** the node now needs (all optional — bridge endpoints return 503 if unset):
- `SOLANA_RPC_URL`
- `SOLANA_SPL_MINT_ADDRESS`
- `SOLANA_MINT_AUTHORITY_SECRET_KEY` (base58)
- `BRIDGE_BLOB_PRIVATE_KEY` (hex)

These are the same secret names already in Lovable Cloud, so a node operator just exports them.

**Update `blobRelay.ts`** — when `activeMode === "node"`, route `fetchBridgeConfig`, `registerBridgeRequest`, `pollBridgeRequest`, `registerRedeem`, `pollRedeem` to the node's REST endpoints. `fetchBridgeHistory` / `fetchRedeemHistory` are explorer-only — keep on Supabase for now (read-only, low risk), with a TODO to add `/bridge/history` later.

Keep the Supabase edge functions in place so light clients pointing at `mode=supabase` still work during the transition.

## 3. Address registry on the node

Move `register-address` off Supabase. The full node already has an `addresses` table; just add:

- `POST /addresses/register` — body `{ address, publicKey, signature, timestamp }`. Verify the signature, upsert into `addresses`. Same payload format as the edge function.
- `GET /addresses` — paginated list for the explorer (`?limit=100&offset=…`), returns the same fields the `blob_addresses_public` view exposes today, computed on the fly from blocks + entries.

Update `Relay.registerAddress` and `Relay.fetchAddresses` to prefer the node when in node mode.

---

## 4. Deployment + bootstrap

The whole point of decentralization is multiple operators running this. Make that easy.

**`node/Dockerfile` (new)** — multi-stage Node 20 image, copies `node/`, runs `npm ci && npm run build`, exposes 8080, mounts `/data` for SQLite.

**`node/docker-compose.yml` (new)** — single-service example with volume + env file, plus a commented-out `PEERS=` line showing how to join the network.

**`node/PEERS.md` (new)** — short doc:
- The official seed peers (URLs we'll fill in once deployed).
- How to add your node to `BUNDLED_NODES` via PR.
- How `PEERS=` env var bootstraps gossip.

**Fill in real URLs** in:
- `desktop-app/src/hooks/useNodeConfig.ts` `BUNDLED_NODES`
- `node/PEERS.md` seed list
(Placeholders for now — you swap them in once your nodes are live. Plan accommodates the gap.)

**Update `src/pages/RunANode.tsx`** with the Docker quickstart:

```bash
docker run -d -p 8080:8080 -v blobchain:/data \
  -e PEERS=wss://node.blobchain.network/ws,wss://node-eu.blobchain.network/ws \
  blobchain/node:latest
```

---

## 5. Wallet UX polish (small, high-impact)

Now that the wallet can talk to any node:

- **`RelayStatusBadge`** (currently dev-only): show in production too, but as a tiny corner pill that's only visible if mode = `node` (so users know they're using a self-hosted/community node, not the central one).
- **`NetworkView`**: show `/peers` data — list of connected peers + their heights. Today it shows `node_count` from the latest block which is always 1.
- **`NodeSetupScreen`** (desktop): after connecting, periodically re-check the chosen node's `/health`; if unreachable for >30s, surface a banner with a "Switch node" button that re-opens the picker.

---

## Files touched

**New**
- `node/lib/peers.ts`, `node/lib/ingest.ts`, `node/lib/bridge.ts`
- `node/Dockerfile`, `node/docker-compose.yml`, `node/PEERS.md`

**Edited**
- `node/full-node.ts` — wire peers, bridge routes, address routes, `/peers`, refactor handlers to use `ingest*`.
- `node/lib/db.ts` — add `bridge_requests`, `bridge_redeems` tables + statements.
- `node/lib/validate.ts` — add `validateBlock` for peer ingest.
- `node/wsProtocol.ts` — no breaking changes, but document peer use of the same protocol.
- `node/README.md` — document peering, bridge, deployment.
- `src/lib/blobRelay.ts` — route bridge + addresses to the node when in node mode; add `fetchPeers`.
- `src/lib/blobNodeClient.ts` — add `fetchEntries`, `fetchPeers`, `fetchBridgeConfig`, bridge mint/redeem REST helpers.
- `src/components/blob/NetworkView.tsx` — show real peer list.
- `src/components/blob/RelayStatusBadge.tsx` — production visibility when mode = node.
- `src/pages/RunANode.tsx` — Docker quickstart, peer config doc.
- `desktop-app/src/screens/NodeSetupScreen.tsx` — health watchdog after connect.
- `desktop-app/src/hooks/useNodeConfig.ts` — placeholder for real URLs (you fill in).

**NOT touched yet** (intentional)
- `supabase/functions/bridge-*` — kept as-is so legacy clients keep working during the cutover. Remove in a follow-up phase once all wallets are ≥ the version that talks to the node bridge.
- `supabase/functions/seal-block`, `submit-tx`, `submit-entry` — same reason.
- Access-code gate — stays on Supabase, gets deleted when alpha lock is removed.

---

## Out of scope (Phase 4 territory)

- Deep reorgs (>1 block). Phase 3 only handles single-block ties; a multi-block fork would still require manual intervention.
- DHT/peer discovery. Bootstrap list only — no auto-discovery yet.
- Pruning / state snapshots for new node fast-sync. Today a fresh node replays from height 1.
- Binary release of the desktop app bundling a local node for one-click sovereignty.

---

## Acceptance criteria

After this phase you can:

1. `docker compose up` two copies of the node on different ports with `PEERS` cross-pointed → mining on node A produces a block that appears on node B within ~1s, and both report `peers: 1` on `/health`.
2. Set `VITE_BLOB_NODE_URL` in the browser to either node → wallet works identically (send tx, mine, see new blocks).
3. Initiate a bridge mint via the node's `/bridge/mint` endpoint → SPL tokens land in the destination Solana wallet without any Lovable Cloud edge function being invoked.
4. Kill node A → wallet pointed at A reconnects to node B (or shows the "switch node" banner) and stays in sync.
