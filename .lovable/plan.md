## Phase 1 — Decentralization groundwork

You picked: deliver `full-node.ts` + protocol first, run locally on `ws://localhost:8080`, persist with SQLite, move bridge to the full node eventually but keep access-code/locked-gate untouched. Browser code is **not** modified in this phase — current Supabase relay keeps working.

### Deliverables

1. **`node/full-node.ts`** — standalone Node 20 + TypeScript full node
   - HTTP (Express) + WebSocket (`ws`) on port `8080`
   - SQLite via `better-sqlite3` at `./data/blobchain.db`
   - Tables: `blocks`, `mempool`, `entries`, `addresses` (mirrors current Supabase schema)
   - Block sealer: 120s ticker that reuses the exact logic from `supabase/functions/seal-block` (PRNG, weighted lottery, halving, 20M cap, deterministic hash). Ported verbatim so block hashes match the current chain rules.
   - Validators for `submitTx` (secp256k1 verify, balance, fee floor) and `submitEntry` (signature over `address|score|block_height|block_seed`, replay-input hashing — same as `submit-entry`).
   - Gossip: on accepted tx/entry/block, broadcast to all subscribed WS clients.
   - REST helpers for debugging: `GET /chain/tip`, `GET /blocks?from=&limit=`, `GET /mempool`, `GET /health`.
   - Graceful shutdown, structured logs, reconnection-friendly (idempotent inserts).

2. **`node/wsProtocol.ts`** — shared message types
   - `ClientMsg = Subscribe | SubmitTx | SubmitEntry | GetChainTip | GetBlocks`
   - `ServerMsg = NewBlock | NewTx | NewEntry | ChainTip | BlocksRange | Ack | ErrorMsg`
   - Discriminated unions, exported so the browser can import the same file later.
   - Lives under `node/` so the browser can `import type` from it without bundling Node deps.

3. **`node/package.json`** — minimal manifest
   - Deps: `better-sqlite3`, `ws`, `express`, `@noble/secp256k1`, `@noble/hashes`, `tsx`, `typescript`, `@types/node`, `@types/ws`, `@types/express`
   - Scripts: `"dev": "tsx watch full-node.ts"`, `"start": "tsx full-node.ts"`

4. **`node/README.md`** — local run instructions
   - `cd node && npm i && npm run dev`
   - Env vars: `PORT`, `DB_PATH`, `GENESIS_TIME_MS` (default matches current chain)
   - How to point a future browser build at `ws://localhost:8080`
   - Notes on later deploying 4 nodes (Fly.io/Railway placeholder section)

5. **`node/lib/`** (small internal modules to keep `full-node.ts` readable)
   - `crypto.ts` — sha256 + secp256k1 verify wrappers
   - `consensus.ts` — `mkPrng`, `pickWinner`, `getRewardForHeight`, `computeBlockHash`
   - `validate.ts` — tx + entry validation
   - `db.ts` — SQLite schema bootstrap + prepared statements
   - `gossip.ts` — WS broadcast helpers

### Out of scope for this phase

- No edits to `src/`, no rewrite of `blobRelay.ts`, no `useLightChain.ts`, no `BlobChainApp.tsx` changes.
- Bridge port to full node (`bridge-mint`, `bridge-redeem`, Solana RPC) — deferred to Phase 3.
- Multi-node peer-to-peer gossip — Phase 2 will add node↔node WS peering once one node is proven.
- Access code / locked gate — left fully alone (you said it's being removed at launch).

### How it integrates with existing code

- The full node does **not** read/write Supabase. It is a parallel implementation of the same consensus rules.
- For local testing you can manually copy the genesis hash + `GENESIS_TIME_MS` from the current chain so a fresh node starts at height 1 with the same rules.
- Once you confirm the node runs and seals blocks correctly locally, Phase 2 will wire the browser to it via a new `useLightChain.ts` hook behind a feature flag, so you can A/B against the Supabase relay.

### Verification

- `cd node && npm run dev` boots without errors.
- Hit `curl http://localhost:8080/health` → `{ ok: true, height, tipHash }`.
- Open a `wscat` connection, send `{"type":"subscribe"}`, then `{"type":"submitEntry", ...}` with a valid signed entry — server acks and the next block (after 120s) lists it.
- SQLite file persists across restarts; restart resumes at the same tip.

### Phase 2 preview (not part of this plan)

Once you approve Phase 1 and the node runs cleanly:
- Build `src/lib/lightChain.ts` + `src/hooks/useLightChain.ts` (IndexedDB last-500 blocks, header chain).
- Rewrite `blobRelay.ts` to speak the WS protocol with auto-reconnect + node failover.
- Add Network tab indicator showing connected node URL + peer count.
- Feature-flag rollout so the Supabase path stays available until you flip the switch.
