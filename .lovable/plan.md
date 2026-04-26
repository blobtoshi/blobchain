## Diagnosis — what's actually causing the lag

After reading `BlobRunGame.tsx`, `level.ts`, and `simulator.ts`, the lag is from the **render path**, not the simulator. The physics tick is cheap; rendering is doing way too much per frame.

Hot spots, in order of cost:

1. **`shadowBlur` in the inner draw loop** — `drawFork`, `drawLowBar`, `drawToken`, particles, and the combo HUD all set `shadowBlur: 8–18`. Canvas shadow blur is one of the slowest 2D ops; it forces an off-screen blur pass for *every* shape, *every* frame. With 5–15 obstacles + tokens + particles on screen, this is the #1 cost.
2. **Gradients re-created every frame** — `drawBG` builds a new `createLinearGradient` for the ground every frame (line 90). `drawFork`, `drawLowBar`, `drawToken` each build 1–2 fresh gradients per shape per frame. Gradient construction allocates and is not free.
3. **Trail uses `globalCompositeOperation = "lighter"` + 7 extra `drawImage` calls per frame** with `ctx.save/restore` each — composite mode changes are pipeline stalls.
4. **`state.tokens.filter(t => t.alive).length` called twice per tick** to detect pickups (lines 213, 217) — allocates two arrays every frame just to compare counts.
5. **`requestAnimationFrame` loop is `async`** (line 203). The `await` at end-of-run is fine, but making the *whole* loop async wraps every frame in a microtask + promise chain. Tiny but measurable input-to-render latency.
6. **`onTap` uses a 120 ms `setTimeout` to release jump** (line 285) — this *forces* every tap into a 120ms hold instead of letting the user control jump height. Feels like input lag on touch.
7. **Obstacle/token arrays reallocated every tick** via `.filter(...)` (simulator.ts 163, 165) — minor GC pressure.
8. **HUD font strings rebuilt every frame** — small but adds up; also `state.score.toLocaleString()` allocates each frame.

## Fixes

### Render (biggest wins)

- **Kill `shadowBlur` from the per-frame path.** Pre-bake the glow into either:
  - a one-time offscreen canvas per obstacle/token sprite (drawn once with shadow, then `drawImage`'d each frame), OR
  - drop shadow entirely and replace with a cheap additive overlay rect / radial gradient sprite. Sprites are the safer choice — keeps the look.
  - HUD glow (`combo`, score panel) → render to an offscreen canvas, redraw only when combo/score change.
- **Cache gradients.** `drawBG` already caches sky/halo/ground; remove the re-created ground gradient at line 90. For fork/low-bar/token, store gradients on a module-level `Map` keyed by shape dimensions — they never change.
- **Trail simplification.** Reduce trail length from 8 → 4, drop `globalCompositeOperation = "lighter"`, drop per-step `save/restore` (use a single `setTransform` matrix push). Keep `imageSmoothingEnabled = false` set once on the ctx instead of every frame.
- **Particles** — drop `shadowBlur`; use a pre-rendered radial-gradient sprite drawn with `globalAlpha`. Cap particle count (e.g., 64) to bound worst case.

### Simulator / loop

- **Replace double `.filter(...).length`** with a counter: have `tick()` return (or set on state) `state.tokensPickedThisFrame: number`, then spawn that many pickup particles. Removes 2 array allocs/frame.
- **In-place obstacle/token compaction** instead of `.filter(...)` — write-pointer pattern. Removes 2 more array allocs/tick.
- **De-async the loop.** Make `loop()` synchronous; move the submit/sign work (the only `await` chain) into a separate function called from the dead branch — fire-and-forget, no await on the rAF path.
- **Stable `setGs` updates.** Currently `setGs` only fires on combo change (good), but on the dead-frame it sets twice (`status` + `score`). Coalesce into one `setGs`.

### Input latency

- **Remove the 120ms `setTimeout` in `onTap`.** Release on `onTouchEnd` (already wired on the canvas) — gives the player real variable-height jumps and removes the "sticky" feel.
- **Use `passive: false` listeners explicitly** for keydown so `preventDefault` doesn't trigger the passive-listener warning path.
- **Move keydown handler off `window` to the canvas (with `tabIndex={0}` and autofocus)** so the browser doesn't have to bubble through document listeners.

### HUD cache

- Cache the static HUD chrome (rounded panel, labels "SCORE"/"BLOCK #N"/"SPEED") to an offscreen canvas at run start; per frame only draw the dynamic numbers (score, speed, combo).

## Files touched

- `src/components/blob/BlobRunGame.tsx` — loop, trail, particles, HUD cache, input handlers, remove tap timeout, de-async loop.
- `src/lib/blob/level.ts` — gradient cache for fork/low-bar/token, prebaked glow sprites, kill per-frame `shadowBlur`, fix duplicate ground gradient.
- `src/lib/blob/simulator.ts` — in-place compaction for obstacles/tokens, expose `tokensPickedThisFrame` counter.

## Out of scope (won't change)

- **Simulator math, constants, `ENGINE_VERSION`** — these are consensus-critical (same module runs in the verifier edge function). Any drift = invalid replays. All sim changes are non-observable refactors (compaction, counter), no math changes, no version bump.
- **Visual style** — the goal is "looks the same, runs smooth." Glow is preserved via prebaked sprites, not removed.

## Expected result

- Steady 60 fps on mid-range laptops and most phones (was likely dropping to 25–40 fps when many obstacles + particles + combo glow stacked up).
- Input → on-screen response within 1 frame (~16ms) instead of the 120ms artificial hold on taps.
- ~80% fewer per-frame allocations → smoother frame pacing, no GC hitches.