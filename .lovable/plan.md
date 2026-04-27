# Cleanup + Smart Node Picker + Self-Host Option

Three small, focused changes.

## 1. Delete the dead `useNodeClient` hook

- Remove `desktop-app/src/hooks/useNodeClient.ts`. It has zero importers — `BlobChainApp` owns all node/relay state via `setRelayOverride` + the website's own hooks. Nothing else changes.

## 2. Smarter desktop Node Setup screen

Rewrite `desktop-app/src/screens/NodeSetupScreen.tsx` so first-run users don't need to know anything about node URLs, but power users keep full control.

**Built-in fallback list** (defined as a constant in `desktop-app/src/hooks/useNodeConfig.ts`, exported as `BUNDLED_NODES`):

```ts
[
  { label: "Official (blobchain.network)", url: "https://node.blobchain.network" },
  { label: "Community node — EU",          url: "https://node-eu.blobchain.network" },
  { label: "Community node — US",          url: "https://node-us.blobchain.network" },
  { label: "Local node",                   url: "http://localhost:9090" },
]
```

(These URLs are placeholders to be filled in later — the structure is what matters now.)

**Behavior on screen load:**

1. Ping every bundled node in parallel using `BlobNodeClient.healthcheck(url, 2500)` — measure round-trip ms with `performance.now()`.
2. Auto-select the reachable node with the lowest latency.
3. Show a status line: `"Auto-selected Official node — 87 ms"` (or `"No bundled nodes reachable — pick one or enter a custom URL"`).

**UI layout (using existing shadcn primitives):**

```text
┌─────────────────────────────────────────────┐
│ Choose a node                               │
│                                             │
│ [ Select dropdown ▾ ]                       │
│   • Official      — 87 ms   ✓ best         │
│   • Community EU  — 142 ms                 │
│   • Community US  — 198 ms                 │
│   • Local node    — unreachable            │
│   • Custom URL…                            │
│                                             │
│ (if Custom selected:)                       │
│ [ http://… input ]   [ Test ]               │
│                                             │
│ [ Re-scan ]              [ Connect → ]      │
│                                             │
│ ─────────  or  ─────────                    │
│                                             │
│ Want full sovereignty?                      │
│ [ Run your own node ]  →  opens guide      │
└─────────────────────────────────────────────┘
```

- Dropdown uses shadcn `Select`. Each item shows label + ping (color-coded: green <150ms, amber <400ms, red/strikethrough if unreachable). The fastest reachable one gets a "best" badge.
- "Custom URL…" reveals an `Input` + "Test" button. Validates `^https?://`. Test result shown inline.
- "Re-scan" re-runs all pings.
- "Connect →" is disabled until a reachable URL is selected (custom URLs allowed even if untested — same forgiving behavior as today).
- "Run your own node" button opens the self-host guide (see section 3 — same page, in-app via Electron `shell.openExternal` so it opens in their browser).

**Persistence:** keep the current `useNodeConfig` storage (`{ current, saved }`). When the user picks a custom URL, append it to `saved` so it appears in the dropdown next launch under a "Recent" group.

## 3. "Run your own node" on the website

Add a new lightweight page at `/run-a-node` (route added in `src/App.tsx`) with a clean glass-card layout matching the rest of the site. Content:

- One-paragraph "why run your own node" pitch (sovereignty, no third-party trust, contribute to the network).
- Quickstart code blocks (copy-buttons) using the existing `node/` package:
  ```bash
  git clone https://github.com/<org>/blobchain
  cd blobchain/node
  npm install
  npm start                  # listens on :9090
  ```
- "Then in the desktop app: Settings → Node → Custom URL → `http://localhost:9090`".
- Link to the GitHub repo and the `node/README.md`.

**Entry points to the page:**

- Footer of `BlobChainApp` (currently just shows `Blob Chain © 2026`) — add a small `Run your own node` link next to the copyright.
- Network tab: small inline link/banner near the node list saying "Don't see your node? Run one →".
- Desktop NodeSetupScreen "Run your own node" button (section 2) links to the same URL.

## Files changed

**Deleted**
- `desktop-app/src/hooks/useNodeClient.ts`

**Edited**
- `desktop-app/src/hooks/useNodeConfig.ts` — export `BUNDLED_NODES` constant; keep `saved` list as recent customs.
- `desktop-app/src/screens/NodeSetupScreen.tsx` — full rewrite per section 2 (parallel ping, auto-select, dropdown, custom input, self-host CTA).
- `src/App.tsx` — add `/run-a-node` route.
- `src/pages/BlobChainApp.tsx` — add footer link to `/run-a-node`.
- `src/components/blob/NetworkView.tsx` — small "Run one →" link.

**New**
- `src/pages/RunANode.tsx` — the guide page.

## Out of scope (saved for later)

- Bridge graceful-degradation when edge functions are unreachable.
- Bundling the node binary inside the desktop app for one-click local-node start.
- Filling in the real public node URLs (placeholders for now — you'll provide once the official ones are live).
