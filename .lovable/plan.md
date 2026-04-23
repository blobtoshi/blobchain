

## Lighter, modern UI refresh (keep cobalt/cyan)

Goal: lift the whole app out of near-black into a clean, modern "soft slate" palette with the same cobalt + cyan brand accents. Because every screen (Wallet, Mine, Network, Bridge, Block Explorer, Send Tx, Redeem) consumes the same semantic tokens, this is a **single-file change to `src/index.css`** and cascades everywhere automatically.

### What changes

1. **Lighter base surfaces** — shift background/card/popover/secondary/muted from ~5–12% lightness up to ~14–22%. Still dark-mode, but soft slate instead of near-black.
2. **Higher-contrast borders & inputs** — borders go from L=14% to L=22% so cards have visible edges on the lighter background.
3. **Brighter foreground & muted text** — foreground L=94 → 96, muted-foreground L=58 → 68 for better readability on the lighter surfaces.
4. **Brand colors unchanged** — cobalt primary (`215 95% 56%`) and cyan accent (`188 95% 55%`) stay as-is. Glow, gradient, and `text-brand-gradient` keep their punch against the lighter base.
5. **Glass surfaces refreshed** — `--glass` lightness raised and alpha lowered so frosted panels read as light-on-light glass instead of dark-on-dark; `--glass-border` and `--glass-hi` brightened to match.
6. **Softer shadows** — `--shadow-card` opacity reduced (0.6 → 0.35) so cards float gently instead of sitting in deep wells.
7. **Background ambient gradient** — increase the cobalt + cyan radial-gradient alphas in `body::before` (0.10/0.08 → 0.16/0.14) so the lighter base still has brand atmosphere.
8. **Sidebar tokens** — mirror the same lightness shift for `--sidebar-*` tokens.
9. **`.dark` block** — apply the same updated values so explicit dark-mode contexts match.

### New token values (HSL)

```text
--background:    222 28% 14%   (was 222 35% 5%)
--card:          220 26% 17%   (was 220 32% 7%)
--popover:       222 28% 16%   (was 222 38% 6%)
--secondary:     220 22% 22%   (was 220 28% 12%)
--muted:         220 22% 20%   (was 220 28% 10%)
--border:        220 20% 28%   (was 220 28% 14%)
--input:         220 22% 22%   (was 220 28% 12%)
--foreground:    210 30% 96%   (was 210 30% 94%)
--muted-foreground: 215 16% 68% (was 215 18% 58%)
--glass:         220 26% 20% / 0.55
--glass-border:  200 40% 90% / 0.10
--glass-hi:      200 40% 90% / 0.16
--shadow-card:   0 8px 32px hsl(222 50% 4% / 0.35)
```

### What does NOT change

- No component files edited — semantic Tailwind classes (`bg-background`, `bg-card`, `border-border`, `text-muted-foreground`, `glass`, `surface`, `text-brand-gradient`) automatically pick up the new values across Wallet, Mine, Network, Bridge, Block Explorer, Send/Redeem.
- The Blob Run game canvas keeps its dark playfield (it uses hard-coded `rgba(7,12,22,…)` for the in-game HUD so the gameplay area still feels immersive).
- All cobalt/cyan brand elements, gradients, glow rings, and the `ring-cyan-flair` accent stay intact.
- No layout, spacing, typography, or component-structure changes.

### File touched

- `src/index.css` — `:root`, `.dark`, and `body::before` token values only.

### Verification after apply

Spot-check each tab (Wallet, Mine, Network, Bridge, Block Explorer) at the current 414×646 mobile viewport plus desktop to confirm: cards visibly separate from background, text remains readable, brand cobalt/cyan still pop, no element looks washed out.

