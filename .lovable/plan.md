## Update `.env.local` with new localtunnel URL

Replace the `VITE_BLOB_NODE_URL` value in `.env.local` with the new tunnel URL.

### Current contents
```
VITE_BLOB_NODE_URL=https://brown-heads-travel.loca.lt
VITE_BLOB_RELAY_MODE=auto
```

### New contents
```
VITE_BLOB_NODE_URL=https://whole-mammals-tap.loca.lt
VITE_BLOB_RELAY_MODE=auto
```

### After approval
You'll need to **restart the Vite dev server** (Ctrl+C in the terminal running `npm run dev`, then `npm run dev` again) — Vite only reads `.env.local` at startup.

Then reload `http://localhost:8081/` and the RelayStatusBadge should connect to the new tunnel.