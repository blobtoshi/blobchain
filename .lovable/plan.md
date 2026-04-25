## Problem

Every meaningful source file in the project starts with `// @ts-nocheck` — 23 files in total, covering essentially the entire app and edge function:

- All of `src/lib/blob/*` (chain, simulator, level, fees, explorer, crypto, constants)
- All of `src/components/blob/*` (BlobRunGame, BlockExplorer, BridgeScreen, MempoolView, MineHero, MiningPanel, NetworkView, RedeemPanel, SendTxForm, SolanaProvider, WalletScreen)
- All hooks (`useBlockchain`, `useWalletVault`, `useMempoolHistory`)
- `src/pages/Index.tsx`
- `supabase/functions/submit-entry/_simulator.ts`

On top of that, `tsconfig.app.json` has `strict: false`, `noImplicitAny: false`, `noUnusedLocals: false`, `noUnusedParameters: false`. So even without `@ts-nocheck`, the safety net is loose. Right now `tsc` reports 0 errors — not because the code is clean, but because it isn't being checked.

## What the real error count looks like

I temporarily stripped `@ts-nocheck` from all 23 files and ran `tsc`. Result: only **14 real errors**, all in 2 files:

- `src/components/blob/BlobRunGame.tsx` — 12 errors: `state._trail` (10x) and `state._lastCombo` (2x) are mutated directly on the simulator state object but aren't declared on its type.
- `src/pages/Index.tsx` — 2 errors: narrowing on a discriminated union `{ ok: true; ... } | { ok: false; error: string }` — code reads `.error` without first checking `ok === false`.

Everything else type-checks cleanly today.

## Plan

### 1. Fix the 12 errors in `BlobRunGame.tsx`

`_trail` and `_lastCombo` are render-only fields the canvas component bolts onto the simulator state. The cleanest fix without touching the deterministic simulator is to keep them on a sibling object owned by the component, not on `state`:

- Add `const renderState = useRef<{ trail: Array<{x:number;y:number;a:number}>; lastCombo: number }>({ trail: [], lastCombo: 0 })`.
- Replace every `state._trail` with `renderState.current.trail` and every `state._lastCombo` with `renderState.current.lastCombo`.
- Reset `renderState.current` whenever a new run starts (same place the simulator state is reset).

This keeps the simulator's state shape pure (important — it's hashed/replayed server-side) and gives the render scratch its own typed home.

### 2. Fix the 2 errors in `Index.tsx`

Lines 118 and 139 read `result.error` on a union without narrowing. Wrap each in `if (!result.ok) { /* use result.error */ }` (or `if ('error' in result)`). Two small edits.

### 3. Remove `// @ts-nocheck` from all 23 files

Once the 14 errors above are fixed, strip the directive from every file in the list. No other code changes are needed — the rest already type-checks.

### 4. Tighten `tsconfig.app.json` so this can't silently regress

Update `tsconfig.app.json`:

- `"strict": true` (turns on `strictNullChecks`, `noImplicitAny`, etc.)
- `"noImplicitAny": true` (explicit, in case `strict` is loosened later)
- Keep `noUnusedLocals` / `noUnusedParameters` off for now — flipping those will surface dozens of cosmetic warnings unrelated to safety. Can be a follow-up.

Then re-run `tsc -p tsconfig.app.json --noEmit`. Strict mode will likely surface a handful of additional null/undefined issues. I'll fix any that appear (expect a small number — these files compile cleanly today under loose settings, so the strict diff should be modest). If the strict-mode error count turns out to be large (>30), I'll pause and report back rather than blindly chase them, so you can decide whether to defer step 4.

### 5. Add an ESLint rule to prevent `@ts-nocheck` from creeping back

Add `"@typescript-eslint/ban-ts-comment": ["error", { "ts-nocheck": true, "ts-ignore": "allow-with-description" }]` to `eslint.config.js`. From now on, anyone adding `// @ts-nocheck` will get a lint error.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` → 0 errors
- `npm run lint` → no new errors
- Manual smoke: load the game, play a run, confirm the trail/combo visuals still render correctly (this is what `_trail` and `_lastCombo` drove).

## Files touched

- `src/components/blob/BlobRunGame.tsx` (fix + remove nocheck)
- `src/pages/Index.tsx` (fix + remove nocheck)
- 21 other files: remove the `// @ts-nocheck` line only
- `tsconfig.app.json` (enable strict)
- `eslint.config.js` (add ban-ts-comment rule)

No runtime behavior changes except the render-state refactor in `BlobRunGame.tsx`, which is behavior-equivalent.
