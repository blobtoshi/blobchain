## Phase 2 — Light-client wiring + Persistence/Sync API

Goal: the browser app talks directly to a BLOB CHAIN full node (`ws://…/ws` + `http://…/`) for live chain data and submissions, with Supabase kept only as a fallback / for bridge + auth flows. The full node becomes the source of truth for chain state.

### 1. Node-side: persistence + sync API hardening

Files in `node/` (mirrored to `src/server/` — see §3).

- **`/blocks` REST**: already exists; add `?from=H&limit=N` validation, return `[]` past tip, and a `Cache-Control: no-store` header. Add **`/blocks/:height`** for single-block lookups (used for catch-up gap fills).
- **`/chain/tip` REST**: already exists; add an `ETag` so polling clients can short-circuit.
- **`/mempool` REST**: already exists; add optional `?since=<ts>` for delta polls.
- **WebSocket sync flow**: on `subscribe`, server already sends `hello` with `chainTip`. Add a `getBlocks { fromHeight, limit }` round-trip the client uses immediately after `hello` to backfill anything it's missing, then it switches to live `newBlock` gossip. Already wired server-side — just formalize the contract and document it.
- **Backpressure / sanity**: cap `getBlocks` limit at 500 (already), reject `submitTx` payloads >`MAX_TX_SIZE`, drop sockets after N malformed messages. Add a `lastSeenSeq` per socket so a reconnecting client can ask "did I miss anything since seq X?" → respond with a `blocksRange`.
- **Persistence**: SQLite is already used; add a `PRAGMA journal_mode=WAL` on open (better-sqlite3 supports it) and a nightly `VACUUM` no-op stub so we don't surprise ourselves later. Verify `getBlocksFrom` uses an index on `height` (it's PK, so yes).
- **CORS**: already `*`; keep but echo the request origin if present (cleaner DevTools).

### 2. Browser-side: light-client relay

New file `src/lib/blobNodeClient.ts` — thin WebSocket+REST client speaking `wsProtocol`:

- Connection manager with auto-reconnect (exponential backoff, capped 15s), heartbeat `ping`/`pong` every 20s, and an event emitter (`onBlock`, `onTx`, `onTxRemoved`, `onEntry`, `onTip`).
- On (re)connect: receive `hello`, compare its `chainTip.height` to local cache, request `getBlocks { fromHeight: localHeight+1 }` in pages of 100 until caught up, then send `subscribe`.
- Submit helpers: `submitTx`, `submitEntry`, returning the server's `ack` payload (matched by `ref`).
- REST helpers (used at cold start before WS opens, and as fallback if WS is down): `fetchTip`, `fetchBlocks(from, limit)`, `fetchMempool`, `fetchFeeInfo`.
- Config via `VITE_BLOB_NODE_URL` (e.g. `http://localhost:8080`); derives WS URL by swapping scheme + appending `/ws`.

Refactor `src/lib/blobRelay.ts` into a **mode-switching facade**:

- New env flag `VITE_BLOB_RELAY_MODE` = `"node" | "supabase" | "auto"` (default `auto`).
- `auto` mode: try `GET /health` on the configured node URL once at boot; if healthy → use node client; else fall back to current Supabase path.
- All existing exports (`fetchChain`, `fetchMempool`, `pushTx`, `pushEntry`, `subscribeRelay`, `sealBlock`, etc.) keep their signatures so `useBlockchain.ts` and components don't change.
- **Bridge + address registry + access-code flows stay on Supabase** — those aren't part of the node's job. Only chain/mempool/entries/tip switch.
- `sealBlock(height)` becomes a no-op in node mode (the node seals on its own timer); keep the Supabase path for compatibility with the current deployment.

### 3. Code location: mirror node/ into src/server/

- Copy `node/` → `src/server/` so files appear in the Lovable editor.
- Add `src/server/.editor-only.md` explaining: "These files are a mirror of `/node/` for editor visibility. The deployable copy lives in `/node/` and is what `npm run dev` uses. When you edit here, also update `/node/`." (Or: pick `src/server/` as authoritative and have `/node/` be the mirror — say which you prefer. Default: `node/` stays authoritative since it's what's running.)
- Exclude `src/server/` from the Vite build via `tsconfig.app.json` `exclude` and `vite.config.ts` so it doesn't get bundled into the React app.
- Keep `wsProtocol.ts` as the shared contract — copy it into `src/lib/wsProtocol.ts` so the browser client can import it without crossing into `src/server/`. It's framework-free and identical on both sides.

### 4. Rollout / testing

- Default `VITE_BLOB_RELAY_MODE=auto` so production keeps working unchanged (Supabase path) until the node is reachable.
- Local dev: set `VITE_BLOB_NODE_URL=http://localhost:8080` in `.env.local` (you, manually — `.env` is managed). Run the node, refresh, watch DevTools → WS frame inspector to verify `hello` → `getBlocks` → `subscribe` → live `newBlock` gossip.
- Add a tiny dev-only badge in the corner showing relay mode + tip height + WS state (green/yellow/red). Hidden in production builds.

### Out of scope (for later phases)

- Multi-node P2P / peer discovery
- Consensus hardening beyond what's in `node/lib/validate.ts` today
- Migrating bridge + auth off Supabase

### Open question

- Mirror direction: **`node/` authoritative, `src/server/` mirror** (current proposal) or flip it so you edit in `src/server/` and a script syncs to `node/`? The first is safer (your running process never goes stale); the second is more ergonomic. I'll go with the first unless you say otherwise.
