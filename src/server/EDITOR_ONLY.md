# src/server — editor mirror only

This folder is a **read-only mirror** of `/node/` so the BLOB CHAIN full node
files are visible inside the Lovable editor (the `node/` directory is
filtered out by the editor).

**Authoritative copy lives in `/node/`.** That is what runs when you do:

```bash
cd node
npm install
npm run dev
```

Files here are NOT bundled into the React app (Vite's `tsconfig.app.json`
excludes `src/server/**` and the build only follows imports from `src/main.tsx`
which never touches this folder).

If you edit anything here:

1. Mirror the change back into `/node/` (or vice-versa).
2. Restart the running node process.

The shared wire-protocol contract lives in `src/lib/wsProtocol.ts` (a copy of
`node/wsProtocol.ts`). The browser imports the `src/lib/` copy; the node
imports its local copy. Keep both in sync.
