## Update node README to reflect Phase 2

The Phase 2 code work shipped (light-client wiring, `/blocks/:height`, `/mempool?since=`, ETag on `/chain/tip`, malformed-message strike counter, `blobNodeClient.ts`, mode-switching `blobRelay.ts`, `RelayStatusBadge`), but `node/README.md` still says "This is **Phase 1**… browser app is not yet wired to it." That's stale.

### Changes

**`node/README.md`** — rewrite intro + endpoint table + "what's not here" section:

- Intro: change "This is Phase 1… not yet wired" → "Phases 1 & 2 complete: node runs standalone AND the browser light-client can connect to it via `VITE_BLOB_RELAY_MODE=auto|node`."
- Add a new **Browser integration** section with the two env vars:
  ```
  VITE_BLOB_NODE_URL=http://localhost:8080
  VITE_BLOB_RELAY_MODE=auto   # auto | node | supabase
  ```
  and a one-liner explaining the `RelayStatusBadge` shows current mode in dev.
- HTTP endpoints table: add `GET /blocks/:height` (single immutable block) and `GET /mempool?since=<ts>` (delta sync); note `/chain/tip` supports `If-None-Match` / `ETag`.
- WebSocket section: note the malformed-message strike counter (5 strikes → disconnect).
- "What's intentionally not here yet": remove "Browser light-client integration — Phase 2" (done). Keep Solana bridge (Phase 3) and node↔node peering (now Phase 3 too, or rename to "future").
- Bump a "Status" line at the top: `Status: Phase 2 complete. Phase 3 = node↔node peering + bridge port.`

**`src/server/README.md`** — apply the same edits so the editor mirror stays in sync (per `EDITOR_ONLY.md` rule).

### Out of scope

No code changes — purely documentation. The behavior described in the prior summary is already in `node/full-node.ts`, `src/lib/blobNodeClient.ts`, `src/lib/blobRelay.ts`, etc.
