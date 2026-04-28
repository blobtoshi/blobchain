# Multi-node failover, node picker, and Supabase cleanup

Three changes, all driven by your decision: (1) website + desktop should auto-failover across nodes and let the user pick one; (2) the website becomes a pure node client (no Supabase) except for the bridge; (3) the bridge is removed from the desktop app entirely.

---

## 1. What happens when a node goes down today

**Today:** the website probes one URL (`VITE_BLOB_NODE_URL`) at boot. If it's up, you stay on it forever. If it dies mid-session, REST calls fail and the WebSocket retries that same URL with backoff — it never tries another. The desktop app is the same: one pinned URL, no failover.

**After this plan:** both clients carry a list of nodes (bundled defaults + user-added), pick the fastest healthy one automatically, and fail over to the next one when the active node goes unhealthy. The user can also manually pick one in settings and pin it.

---

## 2. Multi-node failover (shared design)

A small `nodePool` module replaces today's single-URL probe.

**Behavior**
- **Node list:** bundled defaults (`node.blobchain.network`, `node-eu`, `node-us`, `localhost:9090`) + any user-added URLs from local storage.
- **Health probing:** `GET /health` against each candidate in parallel on boot, every 60s in the background, and immediately on a failure event.
- **Selection:** lowest-latency healthy node wins. Ties broken by user preference order, then bundled order.
- **Pinning:** if the user explicitly picks a node, that pin overrides auto-selection until they switch back to "Auto."
- **Failover triggers:**
  - WebSocket close + 2 failed reconnect attempts → mark node unhealthy, pick next best, reconnect there.
  - REST call fails 3 times in 10s → same.
- **UI feedback:** a small status pill ("Connected to node-eu · 87ms" / "Switching nodes…" / "All nodes unreachable") so the user always knows where they're talking to.

**Storage**
- Website: `localStorage` key `blob:node-config` → `{ pinned: string|null, custom: string[] }`.
- Desktop: existing `useNodeConfig` already does this on disk via the Electron bridge — extend it with a `pinned`/`auto` flag and a `custom: string[]`.

---

## 3. Node picker UI

### Website — new "Network" settings section
Add a "Node connection" card to the existing **Network** view (`src/components/blob/NetworkView.tsx`):
- Current node + latency + status pill
- Dropdown: `Auto (fastest)` + each bundled node + each saved custom + "Add custom URL…"
- "Test" + "Save" buttons for custom URLs, "Re-scan" button
- "Forget" (×) on saved custom URLs

### Desktop — extend existing `NodeTab`
`desktop-app/src/screens/NodeTab.tsx` already has the URL field and saved list. Add:
- Auto-vs-pinned toggle
- Latency column on the saved list (live ping)
- "Re-scan all" button
- Remove the "single active URL" model and replace with the same `nodePool` pattern

Both UIs share the same mental model so users learn it once.

---

## 4. Supabase removal from the website (everything except the bridge)

You said: keep bridge on Supabase, kill the rest. The relay currently has Supabase fallbacks for chain reads, mempool, entries, addresses, and realtime. All of those go.

**Removed from `src/lib/blobRelay.ts`:**
- `fetchChain`, `fetchMempool`, `fetchFeeInfo`, `fetchEntries`, `fetchAddresses`, `pushTx`, `pushEntry`, `registerAddress`, `sealBlock`, `subscribeRelay` — drop the `activeMode === "supabase"` branches; node is the only path. If no node is reachable, surface "All nodes unreachable" instead of falling back to Supabase.
- `RelayMode` type collapses; `getRelayMode`, `onRelayModeChange`, `setRelayOverride` simplify to "which node URL is active."
- `RelayStatusBadge` becomes a node-status badge.

**Removed entirely from the website:**
- `src/components/AlphaLock.tsx` Supabase calls (this gates access to the app via `access_codes` / `access_requests`). Either:
  - **Option A (cleaner):** remove the alpha gate completely. The app is open.
  - **Option B:** keep the gate but move it to a node endpoint, OR keep it on Supabase as the one extra exception.
  - **Recommended: Option A** — a decentralized chain shouldn't have a centralized access gate. Confirm before I rip it out.

**Kept on Supabase (bridge only):**
- `fetchBridgeConfig`, `registerBridgeRequest`, `pollBridgeRequest`, `fetchBridgeHistory`
- `registerRedeem`, `pollRedeem`, `fetchRedeemHistory`
- The 7 bridge edge functions (`bridge-config`, `bridge-mint`, `bridge-execute-mint`, `bridge-redeem`) and `bridge_requests` / `bridge_redeems` tables stay untouched.

**Node-side bridge code removed:**
- `node/lib/bridge.ts` and the `/bridge/*` REST endpoints in `node/full-node.ts` get deleted. The website's bridge calls go straight to the Supabase edge functions; the node never touches the bridge.

**Edge functions to delete (no longer used):**
- `register-address`, `seal-block`, `submit-entry`, `submit-tx`, `request-access-code`, `verify-access-code` (last two only if we kill the alpha gate).

**Tables to drop (separate migration):**
- `blob_chain`, `blob_entries`, `blob_mempool`, `blob_addresses` — node-only now.
- `access_codes`, `access_requests` — only if we remove the alpha gate.
- Keep `bridge_requests`, `bridge_redeems`.

---

## 5. Bridge removal from desktop

- Delete the "Bridge" entry from the desktop nav.
- Remove the menu/shortcut handler for `nav:bridge`.
- The desktop `App.tsx` mounts the shared `BlobChainApp` from `@web/...`, which still has a Bridge tab. Two options:
  - **Option A:** add a `disableBridge` prop to `BlobChainApp` and have desktop pass `true`. Bridge tab + lazy `BridgeScreen` import are skipped.
  - **Option B:** fork `BlobChainApp` into a desktop variant.
  - **Recommended: Option A.** One prop, no duplication.

Since the desktop app has zero Supabase imports today (verified by ripgrep), removing the Bridge tab also removes its only path to Supabase. The desktop becomes 100% node-only.

---

## 6. Implementation order

```text
Step 1  Build src/lib/nodePool.ts (shared logic)
Step 2  Refactor blobRelay.ts to use nodePool, drop supabase branches
        (except bridge functions)
Step 3  Add Network settings card to website NetworkView
Step 4  Mirror nodePool into desktop-app, refactor NodeTab + NodeSetupScreen
Step 5  Add disableBridge prop to BlobChainApp, set true in desktop
Step 6  Delete node/lib/bridge.ts + node bridge endpoints
Step 7  Decide on AlphaLock (remove vs keep) — pending your answer
Step 8  Migration: drop unused Supabase tables + delete unused edge functions
Step 9  Update README + node/README to document failover + node config
```

---

## 7. Open questions before I start

1. **AlphaLock**: remove the alpha access gate entirely (Option A above), or keep it on Supabase as a second exception alongside the bridge?
2. **Bundled node URLs**: the current list (`node.blobchain.network`, `node-eu...`, `node-us...`) is placeholder. Do you have real public node URLs to seed, or should we ship with just `localhost:9090` until you have at least one public node up?
3. **Failover threshold**: WebSocket fails over after 2 reconnect attempts (~3s); REST after 3 fails in 10s. OK, or do you want it more/less aggressive?
4. **Drop Supabase tables now or later?** Dropping `blob_chain` etc. is irreversible. We can leave them in place (just unused) until you're confident the node-only path is stable.
