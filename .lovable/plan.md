

## Even lighter UI refresh

Push the soft-slate palette one more step toward light. Still dark-mode (white text stays readable), but surfaces move into the 22–32% lightness range so the app reads as a modern "graphite" rather than slate.

### Token changes (`src/index.css` — `:root` and `.dark`)

```text
--background:       222 22% 22%   (was 222 28% 14%)
--card:             220 20% 26%   (was 220 26% 17%)
--popover:          222 22% 25%   (was 222 28% 16%)
--secondary:        220 18% 32%   (was 220 22% 22%)
--muted:            220 18% 30%   (was 220 22% 20%)
--input:            220 18% 32%   (was 220 22% 22%)
--border:           220 16% 40%   (was 220 20% 28%)
--foreground:       210 30% 97%   (unchanged-ish)
--muted-foreground: 215 14% 76%   (was 215 16% 68%)

--glass:            220 22% 30% / 0.50
--glass-border:     200 40% 95% / 0.14
--glass-hi:         200 40% 95% / 0.22

--shadow-card:      0 8px 32px hsl(222 40% 6% / 0.28)
--sidebar-background: 222 22% 23%
--sidebar-accent:     220 18% 32%
--sidebar-border:     220 16% 40%
```

### Ambient gradient (`body::before`)

Bump cobalt/cyan radial alphas slightly so brand atmosphere still reads on the lighter base:
- cobalt: `0.16 → 0.20`
- cyan:   `0.14 → 0.18`

### What does NOT change

- Brand cobalt (`215 95% 56%`) and cyan (`188 95% 55%`) untouched.
- No component files modified — semantic tokens cascade across Wallet, Mine, Network, Bridge, Block Explorer, Send/Redeem.
- Blob Run game canvas keeps its dark in-game playfield (hard-coded RGBA in the canvas renderer).
- No layout, typography, or structural changes.

### File touched

- `src/index.css` — `:root`, `.dark`, and `body::before` only.

