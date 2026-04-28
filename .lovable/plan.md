# Phase 3 — Decentralize for real (IN PROGRESS)

## Status snapshot

**Done this loop:**
- `node/lib/ingest.ts` — `ingestTx`, `ingestEntry`, `ingestBlock` (with full consensus re-validation + depth-1 reorg via lexicographically-smaller-hash tie-break, returning losing-block txs to mempool atomically).
- `node/lib/peers.ts` — `PeerManager` outbound WS dialer: bootstrap from `PEERS=` env, sync-on-(re)connect with 5-block back-window, heartbeat + stall detection, `broadcast()` for forwarding local events to peers, `count()/list()` for `/peers` endpoint.
- `node/lib/bridge.ts` — full BLOB↔Solana bridge ported off Lovable Cloud:
  - SQLite tables `bridge_requests` + `bridge_redeems` (created via `ensureBridgeSchema`).
  - `registerMint` / `processForwardOnce` (BLOB→wBLOB).
  - `registerRedeem` / `processReverseOnce` with raw SPL burn verification + `signAndIngestCredit` that signs a credit tx with `BRIDGE_BLOB_PRIVATE_KEY` and shoves it straight into the local mempool (no HTTP round-trip).
  - Raw SPL mint via `@noble/ed25519` + `bs58` (no `@solana/web3.js`).
- `node/package.json` — added `bs58@^5.0.0` and `@noble/ed25519@2.1.0`.

**NOT yet done (next loop):**

1. **`node/full-node.ts` rewrite** — call `ensureBridgeSchema(d)`; refactor WS handler to call `ingestTx/ingestEntry`; refactor sealer to call `ingestBlock` for self-sealed blocks (so the reorg path gets exercised uniformly); construct `PeerManager({ bootstrapUrls: process.env.PEERS?.split(",") ?? [], db: d, onAppliedBlock: b => gossip.broadcast({type:"newBlock", block: b}), … })`; on every successful local seal also call `peers.broadcast({type:"newBlock", block})`; add HTTP routes:
   - `GET /peers` → `peers.list()`
   - `GET /blocks/:height/entries` → parse `mining_entries` from the block row
   - `GET /entries?height=N` → query `entries` table
   - `POST /addresses/register` → verify sig + upsert
   - `GET /addresses` → paginated computed view (blocks_won, total_mined, best_score, games_played, first_seen, last_active)
   - `GET /bridge/config` → `bridgeConfig()`
   - `POST /bridge/mint` + `GET /bridge/mint?blob_tx_id=…` → `registerMint` / `getMintRow`
   - `POST /bridge/redeem` + `GET /bridge/redeem?sol_signature=…` → `registerRedeem` / `getRedeemRow`
   - Add a 5s interval calling `processForwardOnce(d, log)` and `processReverseOnce(d, log)`.
   - Update `/health` to include `peers: peers.count()`.

2. **Browser wiring** in `src/lib/blobNodeClient.ts` + `src/lib/blobRelay.ts`:
   - Add `fetchEntries(height)`, `fetchPeers()`, `fetchAddresses()`, `registerAddress()`, `fetchBridgeConfig()`, `registerBridgeMint()`, `pollBridgeMint()`, `registerBridgeRedeem()`, `pollBridgeRedeem()` REST helpers.
   - In `blobRelay.ts`, when `activeMode === "node"`, route bridge + addresses + entries to the node helpers. Keep Supabase as fallback for history endpoints.

3. **Deployment** — `node/Dockerfile`, `node/docker-compose.yml`, `node/PEERS.md`, update `src/pages/RunANode.tsx` with Docker quickstart + `PEERS=` example.

4. **UX polish** — `NetworkView` shows real `/peers` data; `RelayStatusBadge` visible in production when mode = node; desktop `NodeSetupScreen` post-connect health watchdog.

5. **Verification** — typecheck the node (`cd node && npx tsc --noEmit`) and run two-node compose smoke test per §Acceptance criteria below.

## Acceptance criteria (unchanged)

1. `docker compose up` two nodes with `PEERS` cross-pointed → mining on A appears on B within ~1s, both report `peers: 1` on `/health`.
2. Browser `VITE_BLOB_NODE_URL` to either node → wallet works identically.
3. Node `/bridge/mint` → SPL tokens land in destination Solana wallet without any Lovable Cloud edge function being invoked.
4. Kill node A → wallet pointed at A reconnects to B (or shows "switch node" banner) and stays in sync.

## Out of scope (Phase 4)

- Deep reorgs (>1 block).
- DHT/peer discovery (bootstrap list only).
- Pruning / state snapshots for fast-sync.
- Bundling node binary in desktop app.
