// Background registry. Each background provides a `draw(ctx, frame, nodes)`
// function compatible with the existing call site in BlobRunGame.tsx:
//
//   drawBG(ctx, state.frame, bgNodes.current)
//
// The `nodes` array is the legacy starfield-like node system the original
// background used. Backgrounds that don't need it just ignore the param.
// All backgrounds render into a CW×CH virtual coord space - the canvas
// transform is already set up in the game loop's `draw()`.

import { CW, CH, GY } from "./constants";
import { drawBG as drawBGDefault } from "./level";

export type BgNode = { x: number; y: number; spd: number };

export type Background = {
  id: string;
  name: string;
  description: string;
  draw: (ctx: CanvasRenderingContext2D, frame: number, nodes: BgNode[]) => void;
};

// ── Obsidian (default) ────────────────────────────────────────────────
// Wraps the existing drawBG from level.ts. Keeps the original look as
// the safe default; players who don't open the cosmetics modal see no
// change from before.
const obsidian: Background = {
  id: "obsidian",
  name: "Obsidian",
  description: "Default. Deep dark canvas with drifting nodes.",
  draw(ctx, frame, nodes) {
    drawBGDefault(ctx, frame, nodes);
  },
};

// ── Hanami (anime-night) ──────────────────────────────────────────────
// Pre-generated layout for the Hanami background: stars, clouds, lanterns,
// and a moon position. Generated once (deterministic) and reused every
// frame so we're only doing math on the moving bits.
function mulberry32(seed: number) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type HanamiLayout = {
  stars: { x: number; y: number; r: number; twinkle: number }[];
  clouds: { x: number; y: number; scale: number; speed: number }[];
  lanterns: { x: number; y: number; bobPhase: number; bobAmp: number }[];
};

let hanamiLayout: HanamiLayout | null = null;
function getHanamiLayout(): HanamiLayout {
  if (hanamiLayout) return hanamiLayout;
  const rng = mulberry32(42);
  const stars: HanamiLayout["stars"] = [];
  for (let i = 0; i < 60; i++) {
    stars.push({
      x: rng() * CW,
      y: rng() * (GY - 80),
      r: rng() < 0.85 ? 0.6 : 1.4,
      twinkle: rng() * Math.PI * 2,
    });
  }
  const clouds: HanamiLayout["clouds"] = [];
  for (let i = 0; i < 5; i++) {
    clouds.push({
      x: rng() * CW * 1.4,
      y: 40 + rng() * 90,
      scale: 0.7 + rng() * 0.7,
      speed: 0.08 + rng() * 0.06,
    });
  }
  // Lanterns float in the upper third of the sky and on the LEFT side
  // of the canvas, away from the moon column on the right. Narrowed from
  // the original full-width spread so they don't fight the reflection.
  const lanterns: HanamiLayout["lanterns"] = [];
  for (let i = 0; i < 4; i++) {
    lanterns.push({
      x: 60 + rng() * (CW * 0.55),
      y: 25 + rng() * 80,
      bobPhase: rng() * Math.PI * 2,
      bobAmp: 3 + rng() * 3,
    });
  }
  hanamiLayout = { stars, clouds, lanterns };
  return hanamiLayout;
}

function drawHanamiCloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.fillStyle = "rgba(140, 200, 240, 0.18)";
  ctx.beginPath(); ctx.ellipse(x,         y,       28 * s, 11 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + 22 * s, y - 4,  22 * s,  9 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x - 20 * s, y - 2,  18 * s,  7 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x +  4 * s, y - 8,  16 * s,  7 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(190, 230, 255, 0.08)";
  ctx.beginPath(); ctx.ellipse(x + 4 * s,  y - 9,  14 * s,  3 * s, 0, 0, Math.PI * 2); ctx.fill();
}

function drawHanamiBlossom(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.fillStyle = "rgba(255, 200, 220, 0.85)";
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * 3.5, y + Math.sin(a) * 3.5, 3.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(255, 230, 180, 0.95)";
  ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
}

const hanami: Background = {
  id: "hanami",
  name: "Hanami",
  description: "Anime-night sky. Moon, cherry branch, and floating lanterns.",
  draw(ctx, frame /* , nodes */) {
    const L = getHanamiLayout();
    // Use the frame counter (60fps physics tick) for time-based animation
    // so it scrolls at the same speed regardless of render rate.
    const t = frame;
    const scroll = frame * 1.2;

    // Sky gradient.
    const sky = ctx.createLinearGradient(0, 0, 0, GY);
    sky.addColorStop(0,    "#070b18");
    sky.addColorStop(0.55, "#0e1a2e");
    sky.addColorStop(1,    "#1a2440");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, CW, GY);

    // Water base. Drawn early so it clears anything painted below the
    // horizon on the previous frame (HUD combo banner, etc.). The moon
    // reflection and ripples are layered on top later, after the moon
    // itself has been drawn, so their positions can match.
    const water = ctx.createLinearGradient(0, GY, 0, CH);
    water.addColorStop(0,   "#0a1a2e"); // continuous with the lower sky stop
    water.addColorStop(0.4, "#081424");
    water.addColorStop(1,   "#040810");
    ctx.fillStyle = water;
    ctx.fillRect(0, GY, CW, CH - GY);

    // Stars.
    for (const s of L.stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * 0.025 + s.twinkle);
      ctx.globalAlpha = 0.3 + tw * 0.5;
      ctx.fillStyle = "#cfe6ff";
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
      if (s.r > 1) {
        ctx.globalAlpha = 0.15 * tw;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // Moon - top-right, bigger and slightly higher than the first pass.
    const mx = CW - 145, my = 88, R = 44;
    const halo = ctx.createRadialGradient(mx, my, R * 0.8, mx, my, R * 3.5);
    halo.addColorStop(0,   "rgba(180, 220, 255, 0.35)");
    halo.addColorStop(0.4, "rgba(120, 180, 240, 0.10)");
    halo.addColorStop(1,   "rgba(120, 180, 240, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(mx, my, R * 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#e8f4ff";
    ctx.beginPath(); ctx.arc(mx, my, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(20, 35, 60, 0.18)";
    ctx.beginPath(); ctx.arc(mx + 12, my - 3, R - 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(40, 60, 90, 0.10)";
    ctx.beginPath(); ctx.arc(mx - 11, my + 8,  5,   0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx +  5, my - 12, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx + 14, my + 11, 4,   0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(mx -  5, my -  4, 2,   0, Math.PI * 2); ctx.fill();

    // Clouds - scroll horizontally with wrap-around.
    for (const c of L.clouds) {
      const x = ((c.x - scroll * c.speed) % (CW + 200) + CW + 200) % (CW + 200) - 100;
      drawHanamiCloud(ctx, x, c.y, c.scale);
    }

    // Lanterns - bob in place, no horizontal scroll (they "float" relative
    // to the player's frame of reference).
    for (const lan of L.lanterns) {
      const y = lan.y + Math.sin(t * 0.03 + lan.bobPhase) * lan.bobAmp;
      const x = lan.x;
      const g = ctx.createRadialGradient(x, y, 2, x, y, 22);
      g.addColorStop(0, "rgba(255, 200, 130, 0.55)");
      g.addColorStop(1, "rgba(255, 160,  90, 0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffb87a";
      ctx.beginPath(); ctx.ellipse(x, y, 6, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5c3a26";
      ctx.fillRect(x - 4, y - 9, 8, 2);
      ctx.fillRect(x - 1, y + 7, 2, 4);
    }

    // Cherry branch - arches in from the top-right, scrolls slowly with
    // parallax. Hand-placed blossom positions for a curated look.
    ctx.save();
    const branchScroll = (scroll * 0.45) % CW;
    ctx.translate(CW - branchScroll, 0);
    ctx.strokeStyle = "#3a2530";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, -20);
    ctx.quadraticCurveTo(-40, 30, -120, 60);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-30,  18); ctx.quadraticCurveTo(-20,  8,  -10,  -8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-70,  42); ctx.quadraticCurveTo(-55, 28,  -50,  12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-100, 55); ctx.quadraticCurveTo(-90, 38,  -95,  20); ctx.stroke();
    const blossoms: [number, number][] = [
      [ -2, -22], [-12,  -8], [-28,  18], [-48,  12], [-55, 28],
      [-70,  42], [-88,  50], [-95,  20], [-110, 58], [-120, 60],
      [-15,   6], [-40,  22], [-78,  28], [-100, 38],
    ];
    for (const [bx, by] of blossoms) drawHanamiBlossom(ctx, bx, by);
    ctx.restore();

    // Water surface effects:
    //   1. Wavy moon reflection - drawn as horizontal slices, each slice
    //      offset left/right by a small sine value driven by time + y, so
    //      the reflection visibly wobbles and refracts. Drawn additively
    //      so it glows against the dark water.
    //   2. Scrolling ripple bands - sine-distorted strokes that drift
    //      downward over time (echoing the parallax feel of the original
    //      ground pattern). Where a band crosses the reflection column,
    //      it interrupts the shimmer and reinforces the "rippled water"
    //      illusion.
    //   3. Horizon rim - thin cyan accent line at GY.
    const reflX = CW - 145;         // matches the moon center x
    const reflTop = GY;
    const reflBot = CH;
    const reflH = reflBot - reflTop;
    const baseReflW = 110;

    // 1. Wavy moon reflection.
    //
    // Stack of thin horizontal slices. Each slice's center x is offset by
    // a sine of (time + slice y), and its width narrows as it descends
    // (so the reflection tapers to a point at the bottom). The result is
    // a glowing column that visibly shimmers as if you're seeing the moon
    // through gently moving water.
    {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const SLICES = 24;
      const sliceH = reflH / SLICES;
      for (let i = 0; i < SLICES; i++) {
        const ry = reflTop + i * sliceH;
        const depth = i / SLICES;            // 0 at top, 1 at bottom
        // Width tapers: full near the top, ~30% at the bottom.
        const w = baseReflW * (1 - depth * 0.7);
        // Horizontal wobble - combine two sines of different frequencies
        // so the wobble doesn't read as a clean periodic pattern. Amplitude
        // grows slightly with depth (deeper water = more refraction).
        const wob = Math.sin(t * 0.06 + i * 0.55) * (3 + depth * 4)
                  + Math.sin(t * 0.11 + i * 0.27) * (1.5 + depth * 2);
        // Alpha fades from bright at the surface to nothing at the bottom.
        // Squared falloff so most of the brightness sits near the horizon.
        const a = (1 - depth) * (1 - depth) * 0.32;
        ctx.fillStyle = `rgba(220, 235, 255, ${a})`;
        ctx.fillRect(reflX + wob - w / 2, ry, w, sliceH + 0.5);
      }
      ctx.restore();
    }

    // 2. Scrolling ripple bands. Move downward over time so the surface
    // reads as flowing toward the camera (mirrors the parallax direction
    // of the original ground pattern). Each band is a sine-distorted
    // stroke; depth fades the alpha so distant ripples recede.
    ctx.save();
    ctx.lineWidth = 1;
    const BANDS = 6;
    const groundH = reflH;
    const SCROLL_SPEED = 0.6;
    for (let r = 0; r < BANDS; r++) {
      // Each band's y scrolls downward and wraps back to GY when it leaves
      // the water region. Modulo on a per-band base offset gives a
      // continuous parade of ripples.
      const bandSpacing = groundH / BANDS;
      const yBase = GY + ((r * bandSpacing + t * SCROLL_SPEED) % groundH);
      // Depth = distance below horizon, 0..1. Deeper = dimmer.
      const depth = (yBase - GY) / groundH;
      const depthFade = 1 - depth * 0.6;
      ctx.globalAlpha = 0.20 * depthFade;
      ctx.strokeStyle = "rgba(160, 210, 240, 1)";
      const phase = t * 0.05 + r * 1.7;
      ctx.beginPath();
      const STEPS = 20;
      for (let i = 0; i <= STEPS; i++) {
        const x = (i / STEPS) * CW;
        const y = yBase
          + Math.sin(phase + x * 0.014) * (1 + depth * 0.8)
          + Math.sin(phase * 0.6 + x * 0.045) * 0.6;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();

    // 3. Horizon rim - thin cyan accent at GY.
    ctx.strokeStyle = "rgba(56, 189, 248, 0.30)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, GY + 0.5);
    ctx.lineTo(CW, GY + 0.5);
    ctx.stroke();
  },
};

// ── Sunset (pastel pink / peach golden-hour beach) ───────────────────
// Warm counterpart to Hanami. Same composition skeleton (large sky body
// + low-right focal celestial object + scrolling sky elements + textured
// ground band at GY..CH) but with sunset palette and beach decorations
// instead of moonlit water.
type SunsetLayout = {
  clouds: { x: number; y: number; scale: number; speed: number }[];
  birds:  { x: number; y: number; bobPhase: number; speed: number }[];
  decorations: {
    type: "scallop" | "spiral" | "cone" | "starfish" | "pebble"
        | "coralBranch" | "coralBrain" | "coralFan";
    x: number; y: number; rot: number; scale: number; color: string;
  }[];
};

let sunsetLayout: SunsetLayout | null = null;
function getSunsetLayout(): SunsetLayout {
  if (sunsetLayout) return sunsetLayout;
  const rng = mulberry32(73);

  const clouds: SunsetLayout["clouds"] = [];
  for (let i = 0; i < 6; i++) {
    clouds.push({
      x: rng() * CW * 1.4,
      y: 40 + rng() * 80,
      scale: 0.7 + rng() * 0.6,
      speed: 0.06 + rng() * 0.05,
    });
  }

  // Birds drift left-to-right (against scroll direction so they pass the
  // camera at a natural-feeling speed). Two small flocks for variety.
  const birds: SunsetLayout["birds"] = [
    { x: 120, y: 90,  bobPhase: 0,    speed: 0.04 },
    { x: 180, y: 100, bobPhase: 0.7,  speed: 0.04 },
    { x: 230, y: 95,  bobPhase: 1.3,  speed: 0.04 },
    { x: 480, y: 70,  bobPhase: 2.1,  speed: 0.045 },
    { x: 520, y: 78,  bobPhase: 2.7,  speed: 0.045 },
  ];

  // Decorations are hand-placed for a curated look. Player corridor at
  // x ~ 100..160 (PX = 130 +/- 30) is left clear so nothing sits behind
  // the runner. Mix of shells, starfish, corals, pebbles distributed in
  // three rough clusters (left / middle / right).
  const decorations: SunsetLayout["decorations"] = [
    { type: "scallop",     x: 60,  y: 320, rot: -0.2, scale: 1.0,  color: "#f4c2c8" },
    { type: "pebble",      x: 85,  y: 308, rot: 0,    scale: 0.7,  color: "#d9c4ad" },
    { type: "starfish",    x: 30,  y: 340, rot: 0.4,  scale: 1.0,  color: "#e89aa3" },
    { type: "spiral",      x: 100, y: 345, rot: 0.6,  scale: 0.9,  color: "#e8b8a8" },
    { type: "coralFan",    x: 50,  y: 318, rot: 0,    scale: 1.0,  color: "#e87a87" },

    { type: "pebble",      x: 200, y: 318, rot: 0,    scale: 0.8,  color: "#c9b599" },
    { type: "cone",        x: 235, y: 335, rot: -0.3, scale: 0.9,  color: "#f0c8b4" },
    { type: "scallop",     x: 285, y: 322, rot: 0.5,  scale: 0.85, color: "#f8d4d8" },
    { type: "coralBranch", x: 310, y: 332, rot: 0,    scale: 1.0,  color: "#e09494" },
    { type: "starfish",    x: 350, y: 345, rot: -0.5, scale: 0.95, color: "#dc8a93" },
    { type: "pebble",      x: 385, y: 312, rot: 0,    scale: 0.6,  color: "#e0cdb5" },
    { type: "coralBrain",  x: 420, y: 340, rot: 0,    scale: 1.0,  color: "#d68188" },
    { type: "spiral",      x: 450, y: 338, rot: -0.2, scale: 1.0,  color: "#dfa8a0" },

    { type: "scallop",     x: 495, y: 325, rot: 0.1,  scale: 0.9,  color: "#f4c2c8" },
    { type: "pebble",      x: 525, y: 318, rot: 0,    scale: 0.75, color: "#c9b599" },
    { type: "starfish",    x: 560, y: 342, rot: 1.0,  scale: 1.05, color: "#e89aa3" },
    { type: "coralFan",    x: 595, y: 320, rot: 0.15, scale: 0.9,  color: "#e09494" },
    { type: "cone",        x: 630, y: 332, rot: 0.4,  scale: 0.95, color: "#f0c8b4" },
    { type: "spiral",      x: 660, y: 345, rot: -0.7, scale: 0.95, color: "#e8b8a8" },
    { type: "coralBranch", x: 690, y: 330, rot: 0.1,  scale: 0.85, color: "#e87a87" },
    { type: "pebble",      x: 715, y: 315, rot: 0,    scale: 0.7,  color: "#d9c4ad" },
    { type: "scallop",     x: 740, y: 335, rot: -0.4, scale: 1.0,  color: "#f8d4d8" },
  ];

  sunsetLayout = { clouds, birds, decorations };
  return sunsetLayout;
}

// ── Sunset cloud / bird helpers ──
function drawSunsetCloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  // Pale pink-white pastel puff
  ctx.fillStyle = "rgba(255, 240, 235, 0.55)";
  ctx.beginPath(); ctx.ellipse(x,         y,       28 * s, 11 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + 22 * s, y - 4,  22 * s,  9 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x - 20 * s, y - 2,  18 * s,  7 * s, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x +  4 * s, y - 8,  16 * s,  7 * s, 0, 0, Math.PI * 2); ctx.fill();
  // Warm lower shadow band
  ctx.fillStyle = "rgba(245, 180, 165, 0.18)";
  ctx.beginPath(); ctx.ellipse(x + 4 * s, y + 4 * s, 22 * s, 4 * s, 0, 0, Math.PI * 2); ctx.fill();
}

// Quick hex shade for outline / detail colours derived from a base hex.
function shadeHex(hex: string, amt = 0.7): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.floor(r * amt)},${Math.floor(g * amt)},${Math.floor(b * amt)})`;
}

// ── Decoration drawers - each takes the decoration record and renders ──
type Deco = SunsetLayout["decorations"][number];

function drawScallop(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.15)";
  ctx.beginPath(); ctx.ellipse(0, 6, 11, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.moveTo(-10, 2);
  ctx.quadraticCurveTo(-12, -10, 0, -10);
  ctx.quadraticCurveTo(12, -10, 10, 2);
  ctx.lineTo(-10, 2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.75);
  ctx.lineWidth = 0.8;
  for (let i = -3; i <= 3; i++) {
    ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(i * 3.2, -9); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(-10, 2);
  ctx.quadraticCurveTo(-12, -10, 0, -10);
  ctx.quadraticCurveTo(12, -10, 10, 2);
  ctx.stroke();
  ctx.restore();
}

function drawSpiral(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.15)";
  ctx.beginPath(); ctx.ellipse(0, 5, 10, 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.moveTo(-9, 4);
  ctx.quadraticCurveTo(-10, -6, 0, -8);
  ctx.quadraticCurveTo(8, -6, 8, 0);
  ctx.quadraticCurveTo(7, 5, 0, 5);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.7);
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(-2, -3);
  ctx.quadraticCurveTo(-5, -5, -3, -7);
  ctx.quadraticCurveTo(0, -8, 2, -5);
  ctx.quadraticCurveTo(3, -2, 0, -1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-9, 4);
  ctx.quadraticCurveTo(-10, -6, 0, -8);
  ctx.quadraticCurveTo(8, -6, 8, 0);
  ctx.quadraticCurveTo(7, 5, 0, 5);
  ctx.closePath(); ctx.stroke();
  ctx.restore();
}

function drawCone(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.15)";
  ctx.beginPath(); ctx.ellipse(0, 4, 7, 1.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = d.color;
  ctx.beginPath(); ctx.moveTo(-6, 3); ctx.lineTo(0, -11); ctx.lineTo(6, 3); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.72);
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 3; i++) {
    const y = -8 + i * 4;
    const halfW = 1.5 + i * 1.5;
    ctx.beginPath(); ctx.moveTo(-halfW, y); ctx.lineTo(halfW, y); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(-6, 3); ctx.lineTo(0, -11); ctx.lineTo(6, 3); ctx.closePath(); ctx.stroke();
  ctx.restore();
}

function drawStarfish(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.15)";
  ctx.beginPath(); ctx.ellipse(0, 6, 11, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  const outer = 10, inner = 4;
  ctx.fillStyle = d.color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.7);
  ctx.lineWidth = 0.8;
  ctx.stroke();
  ctx.fillStyle = shadeHex(d.color, 0.6);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(Math.cos(a) * 5, Math.sin(a) * 5, 0.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.beginPath(); ctx.arc(0, 0, 1.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawPebble(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.18)";
  ctx.beginPath(); ctx.ellipse(1, 3, 7, 1.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = d.color;
  ctx.beginPath(); ctx.ellipse(0, 0, 7, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255, 250, 240, 0.35)";
  ctx.beginPath(); ctx.ellipse(-2, -1.5, 3, 1.2, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.65);
  ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.ellipse(0, 0, 7, 4, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawCoralBranch(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.15)";
  ctx.beginPath(); ctx.ellipse(0, 4, 11, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  const branches = [
    { dx: -6, dy: -8,  tipDx: -8, tipDy: -14 },
    { dx: -2, dy: -10, tipDx: -3, tipDy: -18 },
    { dx:  2, dy: -10, tipDx:  4, tipDy: -17 },
    { dx:  6, dy: -8,  tipDx:  9, tipDy: -13 },
  ];
  ctx.strokeStyle = d.color;
  ctx.lineWidth = 3.2;
  ctx.lineCap = "round";
  for (const br of branches) {
    ctx.beginPath(); ctx.moveTo(0, 3);
    ctx.quadraticCurveTo(br.dx, br.dy, br.tipDx, br.tipDy);
    ctx.stroke();
  }
  ctx.strokeStyle = shadeHex(d.color, 0.7);
  ctx.lineWidth = 0.7;
  for (const br of branches) {
    ctx.beginPath(); ctx.moveTo(0, 3);
    ctx.quadraticCurveTo(br.dx, br.dy, br.tipDx, br.tipDy);
    ctx.stroke();
  }
  ctx.fillStyle = d.color;
  for (const br of branches) {
    ctx.beginPath(); ctx.arc(br.tipDx, br.tipDy, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawCoralBrain(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.18)";
  ctx.beginPath(); ctx.ellipse(1, 4, 10, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = d.color;
  ctx.beginPath(); ctx.ellipse(0, -2, 9, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.65);
  ctx.lineWidth = 0.9;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-6, -3);
  ctx.quadraticCurveTo(-3, -6, 0, -3);
  ctx.quadraticCurveTo( 3,  0, 6, -3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-5, 1);
  ctx.quadraticCurveTo(-2, -2, 1, 1);
  ctx.quadraticCurveTo( 4,  4, 6, 1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-4, -6);
  ctx.quadraticCurveTo(-1, -8, 2, -6);
  ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, -2, 9, 7, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function drawCoralFan(ctx: CanvasRenderingContext2D, d: Deco) {
  ctx.save();
  ctx.translate(d.x, d.y); ctx.rotate(d.rot); ctx.scale(d.scale, d.scale);
  ctx.fillStyle = "rgba(120, 80, 70, 0.15)";
  ctx.beginPath(); ctx.ellipse(0, 5, 8, 1.8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.7);
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(0, 4); ctx.lineTo(0, -2); ctx.stroke();
  ctx.fillStyle = d.color;
  ctx.beginPath();
  ctx.moveTo(0, -2);
  ctx.quadraticCurveTo(-9, -8, -8, -16);
  ctx.quadraticCurveTo(-4, -19, 0, -18);
  ctx.quadraticCurveTo( 4, -19, 8, -16);
  ctx.quadraticCurveTo( 9, -8,  0,  -2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = shadeHex(d.color, 0.65);
  ctx.lineWidth = 0.7;
  const veins = [
    { tx: -6, ty: -15 }, { tx: -3, ty: -17 }, { tx: 0, ty: -17.5 },
    { tx:  3, ty: -17 }, { tx:  6, ty: -15 },
  ];
  for (const v of veins) {
    ctx.beginPath(); ctx.moveTo(0, -2);
    ctx.quadraticCurveTo(v.tx * 0.5, -10, v.tx, v.ty);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0, -2);
  ctx.quadraticCurveTo(-9, -8, -8, -16);
  ctx.quadraticCurveTo(-4, -19, 0, -18);
  ctx.quadraticCurveTo( 4, -19, 8, -16);
  ctx.quadraticCurveTo( 9, -8,  0,  -2);
  ctx.stroke();
  ctx.restore();
}

const sunset: Background = {
  id: "sunset",
  name: "Sunset",
  description: "Pastel pink / peach golden-hour beach with shells, starfish, and corals.",
  draw(ctx, frame /* , nodes */) {
    const L = getSunsetLayout();
    const t = frame;
    const scroll = frame * 1.2;

    // Sky gradient - pastel pink -> peach -> warm coral.
    const sky = ctx.createLinearGradient(0, 0, 0, GY);
    sky.addColorStop(0,    "#fcd9e0");
    sky.addColorStop(0.45, "#fbc4b1");
    sky.addColorStop(1,    "#f5a48b");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, CW, GY);

    // Sand band - top peachy (catches sunset glow), bottom cooler tan.
    // Drawn early so it clears anything from the previous frame in the
    // GY..CH region (HUD combo banner, etc).
    const sand = ctx.createLinearGradient(0, GY, 0, CH);
    sand.addColorStop(0, "#f4d4b8");
    sand.addColorStop(1, "#d9b896");
    ctx.fillStyle = sand;
    ctx.fillRect(0, GY, CW, CH - GY);

    // Faint horizontal grain lines on the sand for texture
    ctx.strokeStyle = "rgba(170, 130, 100, 0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const y = GY + 15 + i * 14;
      ctx.beginPath();
      ctx.moveTo(0, y); ctx.lineTo(CW, y);
      ctx.stroke();
    }

    // Sun - low-right with a soft warm halo that breathes gently.
    {
      const cx = CW - 145, cy = 105, R = 38;
      const pulse = 1 + 0.04 * Math.sin(t * 0.02);
      const haloR = R * 3.2 * pulse;
      const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, haloR);
      halo.addColorStop(0,   "rgba(255, 220, 200, 0.55)");
      halo.addColorStop(0.4, "rgba(255, 190, 160, 0.18)");
      halo.addColorStop(1,   "rgba(255, 180, 150, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff4e6";
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
      const tint = ctx.createRadialGradient(cx - 6, cy - 6, 4, cx, cy, R);
      tint.addColorStop(0, "rgba(255, 250, 230, 0)");
      tint.addColorStop(1, "rgba(255, 200, 170, 0.20)");
      ctx.fillStyle = tint;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    }

    // Clouds drift horizontally with wrap-around.
    for (const c of L.clouds) {
      const x = ((c.x - scroll * c.speed) % (CW + 200) + CW + 200) % (CW + 200) - 100;
      drawSunsetCloud(ctx, x, c.y, c.scale);
    }

    // Distant bird silhouettes. Time-driven horizontal drift with a small
    // sine-bob so they don't move in straight lines.
    ctx.fillStyle = "rgba(70, 50, 60, 0.55)";
    ctx.strokeStyle = "rgba(70, 50, 60, 0.55)";
    ctx.lineWidth = 1.5;
    for (const b of L.birds) {
      const x = ((b.x - t * b.speed) % (CW + 80) + CW + 80) % (CW + 80) - 40;
      const y = b.y + Math.sin(t * 0.03 + b.bobPhase) * 2;
      ctx.beginPath();
      ctx.moveTo(x - 5, y);
      ctx.quadraticCurveTo(x - 2.5, y - 3, x,     y);
      ctx.quadraticCurveTo(x + 2.5, y - 3, x + 5, y);
      ctx.stroke();
    }

    // Beach decorations - static, hand-placed. The sand doesn't move
    // under the player; these sit where they are as the camera scrolls.
    for (const d of L.decorations) {
      switch (d.type) {
        case "scallop":     drawScallop(ctx, d); break;
        case "spiral":      drawSpiral(ctx, d); break;
        case "cone":        drawCone(ctx, d); break;
        case "starfish":    drawStarfish(ctx, d); break;
        case "pebble":      drawPebble(ctx, d); break;
        case "coralBranch": drawCoralBranch(ctx, d); break;
        case "coralBrain":  drawCoralBrain(ctx, d); break;
        case "coralFan":    drawCoralFan(ctx, d); break;
      }
    }

    // Horizon rim - warm golden-coral line at GY, matches the palette
    // (vs. the cyan rim on Hanami / Obsidian).
    ctx.strokeStyle = "rgba(220, 130, 110, 0.40)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, GY + 0.5);
    ctx.lineTo(CW, GY + 0.5);
    ctx.stroke();
  },
};

// ── Registry ─────────────────────────────────────────────────────────
export const BACKGROUNDS: Background[] = [obsidian, hanami, sunset];

export function getBackgroundById(id: string): Background {
  return BACKGROUNDS.find(b => b.id === id) ?? BACKGROUNDS[0];
}