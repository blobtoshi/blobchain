

## Heavy glass UI pass

Push the existing `.glass` / `.glass-hi` / `.surface` system much further so the whole app reads as layered frosted glass over the cobalt/cyan ambient gradient. No layout or component restructuring — just stronger glass tokens, a subtler base, and a richer ambient backdrop so the glass actually has something to refract.

### 1. `src/index.css` — token + utility upgrades

**Base background** (let glass do the work, gradient becomes the hero):
```text
--background: 222 30% 16%   (was 222 22% 22%)  ← darker so glass panels pop
```

**Card / popover become translucent by default** so every Card across the app inherits glass:
```text
--card:    220 24% 24% / 0.55
--popover: 222 26% 22% / 0.70
```
(Tailwind's `bg-card` already uses `hsl(var(--card))`, so alpha flows through.)

**Borders brighter + cooler** to read as glass edges:
```text
--border:       210 40% 80% / 0.16
--input:        220 22% 28% / 0.55
--glass-border: 200 60% 96% / 0.22
--glass-hi:     200 60% 96% / 0.32
--glass:        220 30% 32% / 0.38   ← lower alpha, more see-through
```

**Shadows** — replace flat drop shadow with a soft glow + crisp inner highlight stack:
```text
--shadow-card: 0 1px 0 hsl(0 0% 100% / 0.06) inset,
               0 8px 28px hsl(222 60% 4% / 0.45),
               0 2px 8px hsl(215 95% 56% / 0.08)
```

**`.glass` utility** — heavier blur, saturation, and a top inner highlight:
```css
.glass {
  background: linear-gradient(180deg,
    hsl(220 40% 80% / 0.10) 0%,
    hsl(220 30% 30% / 0.45) 100%);
  backdrop-filter: blur(28px) saturate(180%);
  -webkit-backdrop-filter: blur(28px) saturate(180%);
  border: 1px solid hsl(var(--glass-border));
  box-shadow:
    inset 0 1px 0 hsl(0 0% 100% / 0.10),
    inset 0 -1px 0 hsl(0 0% 0% / 0.20),
    0 12px 40px hsl(222 60% 4% / 0.40);
  border-radius: var(--radius);
}
.glass-hi { /* same recipe, blur(36px), brighter top highlight, ring-cyan-flair-lite */ }
.surface  { /* upgrade to translucent: hsl(var(--card)) with 0.55 alpha + 1px hairline border */ }
```

**New `.glass-pane` utility** for hero panels (Wallet balance card, Mine hero, Bridge cards) — adds a second layered radial highlight in the top-left for a true "Vision Pro" feel.

### 2. `body::before` ambient backdrop — richer so glass refracts something

Add a third radial + faint noise so frosted panels show subtle color shifts:
```css
body::before {
  background:
    radial-gradient(ellipse at 15% 0%,   hsl(215 95% 50% / 0.32), transparent 55%),
    radial-gradient(ellipse at 85% 100%, hsl(188 95% 55% / 0.28), transparent 55%),
    radial-gradient(circle at 50% 50%,   hsl(260 80% 55% / 0.10), transparent 60%);
}
body::after { /* 1.5% noise overlay via inline SVG data-uri, fixed, mix-blend-overlay */ }
```

### 3. Component-level nudges (minimal, surgical)

Only where a component bypasses tokens with hard-coded solid backgrounds:

- **`src/components/blob/WalletScreen.tsx`** — swap any `bg-card` hero block for `glass-pane`; add `glass` to the balance row.
- **`src/components/blob/MineHero.tsx`** — wrap stat tiles in `glass`; HUD overlay gets `glass-hi`.
- **`src/components/blob/MiningPanel.tsx`, `BridgeScreen.tsx`, `RedeemPanel.tsx`, `SendTxForm.tsx`, `NetworkView.tsx`** — replace any `bg-secondary/30` / `bg-muted` panel wrappers with `glass`; keep inner inputs as-is (they already use `--input` which is now translucent).
- **`src/components/blob/BlockExplorer.tsx`** — list rows already use `glass`; bump the outer tab container to `glass-hi` so the layering is visible.
- **`src/components/NavLink.tsx`** — active state gets a thin `glass-hi` pill instead of solid bg.
- **`src/components/ui/dialog.tsx` / `sheet.tsx` / `popover.tsx` / `dropdown-menu.tsx`** — content surfaces switch from `bg-popover` to `bg-popover/70 backdrop-blur-2xl border-white/10` so overlays match the new glass language.

### 4. Explicitly NOT changed

- Brand cobalt (`215 95% 56%`) and cyan (`188 95% 55%`) untouched.
- Blob Run game canvas keeps its opaque dark playfield (canvas pixels, not CSS).
- Typography, spacing, radii, and component structure unchanged.
- No new dependencies.

### Files touched

- `src/index.css` (tokens + utilities + ambient)
- 8 component files above (1–3 className tweaks each, no logic changes)

### Verification

Spot-check Wallet, Mine, Network, Bridge, Block Explorer at 414×646 and desktop. Confirm: cards visibly float as frosted panes, cobalt/cyan ambient bleeds through edges, text contrast still passes, overlays/dialogs match.

