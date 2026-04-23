
## Production polish: cobalt theme + 4 security fixes

### Part 1 — Color refresh (cobalt primary, cyan accent)

Logo is cobalt blue (~hue 215) with cyan highlights (~hue 188). Current scheme is teal (hue 168). Shift the design tokens in `src/index.css` so cobalt is the brand color and cyan is reserved for accents/flair.

**New palette (HSL tokens, dark theme):**
- `--primary` 215 95% 56% (cobalt — buttons, headlines, glows)
- `--accent` 188 95% 55% (cyan — success pills, sparkles, gradient stops)
- `--ring` matches primary
- `--background` 222 35% 5% (slightly cooler bluer-black)
- `--card` / `--popover` deepened cobalt-tinted dark
- Background radial gradient uses cobalt + cyan instead of teal + steel-blue
- Add a `--success` token (hue 142) and a polished `--warning` (hue 38) so badges/toasts read consistently

**Flair touches (used sparingly, not everywhere):**
- Hero headline word "BLOB" gets a subtle cobalt→cyan gradient (`bg-clip-text`) instead of solid primary, with a cyan glow
- Supply progress bar uses a `from-primary via-primary to-accent` gradient (already gradient — just tuned)
- Active nav indicator: 2px underline with cobalt glow + tiny cyan tick on the right edge
- "Connect/Unlock" CTAs keep solid cobalt fill but get a one-time cyan hairline ring on hover
- New-block banner: cobalt for "you mined", soft cyan rim for normal new blocks (replaces current amber)
- Bridge hero icon container: subtle cobalt→cyan radial behind the `TrendingUpDown` glyph

No component refactors required — all visual changes flow through CSS variables and a handful of targeted className tweaks in `MineHero.tsx`, `BridgeScreen.tsx` hero, and `Index.tsx` header/banner.

### Part 2 — Security hardening (4 findings)

These are the outstanding items from the security scan. None affect chain integrity (signatures, supply cap, sequential height, in-block memo binding, idempotent mint/redeem are already enforced server-side); they harden the surrounding surface.

**1. `seal-block` shared-secret + throttle**
- Generate a `SEAL_BLOCK_SECRET` runtime secret. Function rejects requests without matching `X-Seal-Secret` header.
- Frontend client (`src/lib/blobRelay.ts`) does not currently send a secret; sealing is triggered from the client today, which is itself a small concern. We'll move to a self-gated pattern: the function still accepts unauthenticated calls but **only seals the currently-due block** (the one the wall clock has just opened). Any call for an arbitrary past height is rejected. Combined with the existing "previous block must exist" check, this removes the DB-load attack vector without needing a client secret.
- Add an in-memory rate-limit map (per-IP, 1 call / 3s) as belt-and-braces.

**2. Scrub raw DB error messages**
- In `submit-tx`, `submit-entry`, `seal-block`, `register-player`, `bridge-mint`, `bridge-redeem`: replace `bad(error.message, 500)` and the catch-all `bad(String(e), 500)` with `console.error(...)` + `bad("internal error", 500)`.
- Keep all intentional validation strings (`"bad signature"`, `"stale block_height"`, `"username taken"`, etc.) — clients depend on them.

**3. Restrict `blob_players.public_key` exposure**
- The full `public_key` column doesn't need to be world-readable. Remove `public_key` from the public read policy by creating a `public.blob_players_public` view (address, username, blocks_won, total_mined, best_score, games_played, first_seen, last_active) and switching the policy to expose only that view.
- Edge functions (which use the service role) still see the column for signature verification.
- Update frontend `useBlockchain` / explorer queries to read from the view.

**4. Realtime subscription scope**
- Add an RLS policy on `realtime.messages` restricting subscriptions to topics matching the three published tables (`blob_chain`, `blob_mempool`, `blob_entries`) only. Reject any other channel topic.
- Documented Supabase pattern: policy on `realtime.messages` USING `realtime.topic() IN ('blob_chain','blob_mempool','blob_entries')`.

### Files

**Color/UI:**
- `src/index.css` — token shift + background gradient + new `--success` token
- `src/pages/Index.tsx` — header logo glow, hero headline gradient, banner colors
- `src/components/blob/MineHero.tsx` — gradient headline + button hover ring
- `src/components/blob/BridgeScreen.tsx` — hero icon glow background
- `src/components/blob/MiningPanel.tsx` — supply bar already gradient, just verify

**Security:**
- `supabase/functions/seal-block/index.ts` — restrict to current open height + per-IP throttle + scrubbed errors
- `supabase/functions/submit-tx/index.ts`, `submit-entry/index.ts`, `register-player/index.ts`, `bridge-mint/index.ts`, `bridge-redeem/index.ts` — scrubbed 500 errors
- New migration: drop public read of `public_key` on `blob_players`, create `blob_players_public` view + grants, RLS on `realtime.messages` topic whitelist
- `src/hooks/useBlockchain.ts` and any other player query — read from `blob_players_public`

### Notes

- No data migration needed; the view sits on top of existing rows.
- Chain immutability is already guaranteed server-side: no INSERT/UPDATE/DELETE policies on `blob_chain`/`blob_mempool`/`blob_entries`/`bridge_*`, all writes go through the service-role edge functions which verify secp256k1 signatures, enforce supply cap, sequential height, and bind the bridge destination into the signed memo.
- Mark all four security findings as fixed via the security tool after migration applies cleanly.
