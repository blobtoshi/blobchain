
## Fix Blob Run: duckable obstacles, ArrowDown scroll, mobile duck

### 1. Add duckable (overhead) obstacles
In `src/lib/blob/level.ts` `generateLevel`: add a new obstacle type `"low"` (a flying bar you must duck under). Roughly 25% of obstacles become `"low"`; the rest remain ground forks/tall/double.
- Shape: `{ at, type: "low", w: 60, h: 18 }`.

In `src/components/blob/BlobRunGame.tsx` obstacle spawn loop: when `ev.type === "low"`, place it at `y = GY - 60` (clears running blob's head, but collides unless ducking — which lowers hitbox to `ph: 22` already). Use a different draw style so players can read it as "duck".

In `src/lib/blob/level.ts`: add `drawLowBar(ctx, o)` — a horizontal cyan/cobalt glowing bar with a hazard pattern, exported and called from the game's draw loop when `o.type === "low"`.

Tag obstacles with their `type` when pushed to `g.obstacles` so the renderer can pick `drawFork` vs `drawLowBar`.

### 2. Stop ArrowDown from scrolling the page
In the `kd` handler in `BlobRunGame.tsx`, call `e.preventDefault()` for `ArrowDown` too (matching the existing Space/ArrowUp handling). Only do this while the game is mounted (already scoped via the effect's add/remove).

### 3. Mobile duck control
Replace the single full-canvas tap handler with a two-zone overlay on the canvas (only shown on touch devices / always present but transparent):
- Left/upper 70% of canvas → tap = jump (current behavior).
- Right/lower 30% of canvas, plus a small visible "DUCK" button pinned to the bottom-right of the game frame → press-and-hold sets `dRef.current = true`, release clears it.

Implementation: keep the existing `onTouchStart` for jump on the canvas, and add an absolutely-positioned duck button (visible on all viewports, but primarily intended for touch) inside the game container with `onTouchStart`/`onTouchEnd`/`onMouseDown`/`onMouseUp`/`onMouseLeave` handlers that toggle `dRef.current`. Style: small rounded pill, bottom-right, semi-transparent, with a `↓ DUCK` label, so it's discoverable but unobtrusive on desktop.

### Files

- `src/lib/blob/level.ts` — add `"low"` obstacle generation + `drawLowBar` exported renderer.
- `src/components/blob/BlobRunGame.tsx` — preventDefault on ArrowDown; spawn low obstacles at overhead Y; route to `drawLowBar` based on `o.type`; add on-screen duck button with press/release handlers.

### Notes

- Existing duck hitbox (`ph: 22`, lower y center) already lets the player slide under low obstacles, so no physics changes are needed once the bar is positioned correctly.
- The new duck button reuses the same `dRef` ref the keyboard handler uses, so no game-loop changes are required for it to work.
