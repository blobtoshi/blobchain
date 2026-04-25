## Goal

Eliminate the trivial "bot that just stands still and dies on obstacle 1" Sybil pattern from the mining entries. Score only begins accumulating after the player has cleared the very first obstacle.

## Behavior changes

- The blob still runs from frame 1 (visuals, world, speed ramp unchanged).
- `score` and combo bonuses stay locked at `0` until the right edge of the first spawned obstacle has moved past the player's `x` position.
- Once that first obstacle is cleared, scoring switches on for the rest of the run (per-frame +1 and token combos).
- A run that dies before clearing obstacle 1 yields `score = 0`.

## Anti-Sybil enforcement

- **Client**: if the player dies with `score === 0` (i.e. never passed obstacle 1), do **not** submit an entry. The HUD/death screen still shows the result, but no `Relay.pushEntry` / `onEntrySubmit` call is made — keeps the mempool clean of zero-score Sybil rows.
- **Server (`submit-entry`)**: reject entries where the deterministic replay yields `score === 0`. Returns `replay rejected: must clear first obstacle`. This is the consensus-level guarantee; the client check is just UX.

## Engine version bump

Because tick math (when score increments) changes, this is a consensus-affecting change:

- Bump `ENGINE_VERSION` from `1` → `2` in **both** `src/lib/blob/simulator.ts` and `supabase/functions/submit-entry/_simulator.ts`.
- Old in-flight v1 entries will be rejected by `engine_version mismatch`, which is correct — they were generated under the pre-fix rules.

## Files to edit

1. `src/lib/blob/simulator.ts`
   - Add `passedFirstObstacle: false` to `initialState()`.
   - In `tick()`, before incrementing `state.score`/`state.dist`, check: if `!state.passedFirstObstacle` and any spawned obstacle's right edge (`o.x + o.w`) is `< PX`, flip the flag.
   - Gate the `state.score++` and combo-bonus `state.score += ...` lines behind `state.passedFirstObstacle`. (Speed ramp + dist still advance so the world keeps spawning.)
   - Bump `ENGINE_VERSION = 2`.

2. `supabase/functions/submit-entry/_simulator.ts`
   - Mirror the same three changes byte-for-byte.
   - Bump `ENGINE_VERSION = 2`.

3. `supabase/functions/submit-entry/index.ts`
   - After the deterministic re-simulation, add: `if (result.score === 0) return bad("replay rejected: must clear first obstacle");`

4. `src/components/blob/BlobRunGame.tsx`
   - In the death branch of `loop()`, if `finalScore === 0`, skip the `Relay.pushEntry` + `onEntrySubmit` calls and just show the dead screen locally.

## Out of scope

- No DB schema changes.
- No UI copy changes (death screen already shows the score; a `0` is self-explanatory).
- Plausibility-check bounds in `simulator.ts` stay as-is — score only ever shrinks under the new rule, so existing upper bounds remain valid.
