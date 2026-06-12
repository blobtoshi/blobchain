// Obstacle style registry. Each style provides draw functions for the two
// obstacle shapes used by the simulator: "fork" (vertical post / wall) and
// "lowBar" (low horizontal bar that must be ducked under).
//
// IMPORTANT: visual-only. The obstacle's `o.x`, `o.y`, `o.w`, `o.h` and
// `o.type` are consensus-bound - they come from the deterministic level
// generator and must not be modified. Skins only change how those rects
// are *painted*, never the rects themselves. Visual silhouettes should
// also stay within the hitbox bounds wherever possible - any element
// rendered outside the rect cannot kill the player, but extending the
// visual silhouette past the rect would mislead about the danger zone
// and create unfairness between skin choices.

import {
  drawFork as drawForkDefault,
  drawLowBar as drawLowBarDefault,
} from "./level";

export type ObstacleDraw = (ctx: CanvasRenderingContext2D, o: any) => void;

export type ObstacleStyle = {
  id: string;
  name: string;
  description: string;
  drawFork: ObstacleDraw;
  drawLowBar: ObstacleDraw;
};

const defaultStyle: ObstacleStyle = {
  id: "default",
  name: "Default",
  description: "Classic obstacles.",
  drawFork: drawForkDefault,
  drawLowBar: drawLowBarDefault,
};

// ── Hanami obstacle set: hanging paper lantern + red lacquered beam ──

// Lantern fills the full hitbox width so the visual silhouette matches
// the collision rect. No twine above the body - we keep everything
// within the obstacle bounds.
function drawHanamiFork(ctx: CanvasRenderingContext2D, o: any) {
  const cx = o.x + o.w / 2;
  // Render width: lantern body is 60% of hitbox width for a slim
  // hanging-lantern silhouette. Safe to do this because the visual is
  // INSIDE the rect - a player who clears the visual may still touch
  // the invisible hitbox edges, which is harder but doesn't give any
  // advantage. The reverse (visual past the rect) would be unfair and
  // is what we forbid.
  const renderW = o.w * 0.6;
  const renderX = cx - renderW / 2;
  // Small wood tassel just below the body. Sits outside the hitbox
  // (in empty space below the obstacle) so it can't kill the player -
  // pure decoration.
  ctx.fillStyle = "#3a2530";
  ctx.fillRect(cx - 1, o.y + o.h, 2, 4);
  ctx.fillStyle = "#5c3a26";
  ctx.beginPath(); ctx.arc(cx, o.y + o.h + 7, 2.5, 0, Math.PI * 2); ctx.fill();
  // Warm halo - tight and dim. Halo can extend slightly past the hitbox
  // because it's pure light, not a solid, and players don't expect light
  // to kill them.
  const lanternMidY = o.y + o.h / 2;
  const haloR = renderW * 1.4;
  const halo = ctx.createRadialGradient(cx, lanternMidY, renderW * 0.3, cx, lanternMidY, haloR);
  halo.addColorStop(0, "rgba(255, 200, 130, 0.22)");
  halo.addColorStop(0.5, "rgba(255, 160, 90, 0.07)");
  halo.addColorStop(1, "rgba(255, 160, 90, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, lanternMidY, haloR, 0, Math.PI * 2); ctx.fill();
  // Top wood cap
  const capW = renderW + 2;
  const capX = cx - capW / 2;
  ctx.fillStyle = "#3a2530";
  ctx.fillRect(capX, o.y + 2, capW, 5);
  ctx.fillStyle = "#5c3a26";
  ctx.fillRect(capX, o.y + 2, capW, 2);
  // Lantern body
  const bodyTop = o.y + 8;
  const bodyH = o.h - 16;
  const bodyW = renderW - 2;
  const bodyX = cx - bodyW / 2;
  const bodyGrad = ctx.createLinearGradient(0, bodyTop, 0, bodyTop + bodyH);
  bodyGrad.addColorStop(0, "#ffd49a");
  bodyGrad.addColorStop(0.5, "#ffb87a");
  bodyGrad.addColorStop(1, "#dc8c4e");
  ctx.fillStyle = bodyGrad;
  const r = 4;
  ctx.beginPath();
  ctx.moveTo(bodyX + r, bodyTop);
  ctx.lineTo(bodyX + bodyW - r, bodyTop);
  ctx.quadraticCurveTo(bodyX + bodyW, bodyTop, bodyX + bodyW, bodyTop + r);
  ctx.lineTo(bodyX + bodyW, bodyTop + bodyH - r);
  ctx.quadraticCurveTo(bodyX + bodyW, bodyTop + bodyH, bodyX + bodyW - r, bodyTop + bodyH);
  ctx.lineTo(bodyX + r, bodyTop + bodyH);
  ctx.quadraticCurveTo(bodyX, bodyTop + bodyH, bodyX, bodyTop + bodyH - r);
  ctx.lineTo(bodyX, bodyTop + r);
  ctx.quadraticCurveTo(bodyX, bodyTop, bodyX + r, bodyTop);
  ctx.closePath();
  ctx.fill();
  // Vertical paper-rib lines (fewer since the body is narrow)
  ctx.strokeStyle = "rgba(120, 70, 40, 0.35)";
  ctx.lineWidth = 0.7;
  for (let i = 1; i < 3; i++) {
    const rx = bodyX + (bodyW * i) / 3;
    ctx.beginPath();
    ctx.moveTo(rx, bodyTop + 3);
    ctx.lineTo(rx, bodyTop + bodyH - 3);
    ctx.stroke();
  }
  // Two horizontal hoops
  ctx.strokeStyle = "rgba(80, 40, 25, 0.45)";
  ctx.lineWidth = 0.9;
  ctx.beginPath(); ctx.moveTo(bodyX, bodyTop + bodyH * 0.33); ctx.lineTo(bodyX + bodyW, bodyTop + bodyH * 0.33); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bodyX, bodyTop + bodyH * 0.66); ctx.lineTo(bodyX + bodyW, bodyTop + bodyH * 0.66); ctx.stroke();
  // Bottom wood cap
  ctx.fillStyle = "#3a2530";
  ctx.fillRect(capX, o.y + o.h - 7, capW, 5);
  ctx.fillStyle = "#5c3a26";
  ctx.fillRect(capX, o.y + o.h - 7, capW, 2);
  // Subtle inner highlight
  ctx.fillStyle = "rgba(255, 245, 220, 0.20)";
  ctx.fillRect(bodyX + 1, bodyTop + 3, bodyW * 0.25, bodyH - 6);
}

function drawHanamiLowBar(ctx: CanvasRenderingContext2D, o: any) {
  // Torii-style red lacquered crossbeam with twine wraps at the ends.
  const x = o.x, y = o.y, w = o.w, h = o.h;
  // Shadow under the beam
  ctx.fillStyle = "rgba(40, 10, 15, 0.35)";
  ctx.fillRect(x + 2, y + h + 2, w - 4, 3);
  // Subtle warm glow
  const halo = ctx.createRadialGradient(x + w / 2, y + h / 2, w * 0.2, x + w / 2, y + h / 2, w * 0.65);
  halo.addColorStop(0, "rgba(220, 80, 80, 0.10)");
  halo.addColorStop(1, "rgba(220, 80, 80, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w * 0.65, h * 1.4, 0, 0, Math.PI * 2); ctx.fill();
  // Beam body
  const beamGrad = ctx.createLinearGradient(0, y, 0, y + h);
  beamGrad.addColorStop(0, "#a83333");
  beamGrad.addColorStop(0.5, "#8b2c2c");
  beamGrad.addColorStop(1, "#5a1a1a");
  ctx.fillStyle = beamGrad;
  ctx.fillRect(x + 4, y, w - 8, h);
  // Dark wood end caps
  ctx.fillStyle = "#3a2530";
  ctx.fillRect(x, y - 1, 5, h + 2);
  ctx.fillRect(x + w - 5, y - 1, 5, h + 2);
  // Twine wraps - three thin gold-ish lines on each cap
  ctx.strokeStyle = "rgba(220, 180, 130, 0.7)";
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 3; i++) {
    const ry = y + 4 + i * (h - 8) / 2;
    ctx.beginPath(); ctx.moveTo(x, ry); ctx.lineTo(x + 5, ry); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - 5, ry); ctx.lineTo(x + w, ry); ctx.stroke();
  }
  // Horizontal wood grain
  ctx.strokeStyle = "rgba(40, 10, 10, 0.35)";
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 3; i++) {
    const ry = y + 4 + i * (h - 8) / 2;
    ctx.beginPath(); ctx.moveTo(x + 5, ry); ctx.lineTo(x + w - 5, ry); ctx.stroke();
  }
  // Top highlight
  ctx.fillStyle = "rgba(255, 200, 180, 0.30)";
  ctx.fillRect(x + 6, y + 1, w - 12, 2);
}

const hanamiStyle: ObstacleStyle = {
  id: "hanami",
  name: "Hanami",
  description: "Paper lanterns and red lacquered torii beams.",
  drawFork: drawHanamiFork,
  drawLowBar: drawHanamiLowBar,
};

// ── Sunset obstacle set: branching coral pillar + driftwood log ──

// All branch geometry stays within the hitbox so visual silhouette
// matches the danger zone exactly.
function drawSunsetFork(ctx: CanvasRenderingContext2D, o: any) {
  const cx = o.x + o.w / 2;
  const baseY = o.y + o.h;
  const h = o.h;
  // Tight halo (within hitbox bounds for the most part)
  const lanternMidY = o.y + o.h / 2;
  const halo = ctx.createRadialGradient(cx, lanternMidY, o.w * 0.2, cx, lanternMidY, o.w * 0.9);
  halo.addColorStop(0, "rgba(232, 122, 135, 0.13)");
  halo.addColorStop(1, "rgba(232, 122, 135, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.ellipse(cx, lanternMidY, o.w * 0.9, o.h * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  // Base shadow on sand
  ctx.fillStyle = "rgba(80, 30, 30, 0.25)";
  ctx.beginPath(); ctx.ellipse(cx, baseY - 1, o.w * 0.4, 3, 0, 0, Math.PI * 2); ctx.fill();

  // Branch endpoints clamped to maxLat = 0.35 * o.w (well within the
  // hitbox after accounting for the rounded tip bulb at ~3px radius).
  const maxLat = o.w * 0.35;
  const branches = [
    { x1:  0,           y1:  0,        x2:  1,            y2: -h * 0.55, width: 5.5 },
    { x1: -1,           y1: -h * 0.45, x2: -maxLat,       y2: -h * 0.88, width: 4.5 },
    { x1:  1,           y1: -h * 0.40, x2:  maxLat,       y2: -h * 0.95, width: 4.5 },
    { x1:  2,           y1: -h * 0.18, x2:  maxLat * 0.7, y2: -h * 0.40, width: 3.5 },
    { x1: -maxLat * 0.4, y1: -h * 0.65, x2: -maxLat * 0.7, y2: -h * 0.72, width: 2.8 },
  ];
  const absoluteEnds = branches.map(br => ({
    x: cx + br.x2, y: baseY + br.y2, width: br.width,
  }));

  ctx.lineCap = "round";
  // Outline pass - slightly wider than fill
  ctx.strokeStyle = "#6e3a44";
  for (const br of branches) {
    ctx.lineWidth = br.width + 1.2;
    ctx.beginPath();
    ctx.moveTo(cx + br.x1, baseY + br.y1);
    const midX = cx + (br.x1 + br.x2) / 2 + (br.x2 < br.x1 ? -1.5 : 1.5);
    const midY = baseY + (br.y1 + br.y2) / 2;
    ctx.quadraticCurveTo(midX, midY, cx + br.x2, baseY + br.y2);
    ctx.stroke();
  }
  // Main fill - dusty rose
  ctx.strokeStyle = "#dc8a93";
  for (const br of branches) {
    ctx.lineWidth = br.width;
    ctx.beginPath();
    ctx.moveTo(cx + br.x1, baseY + br.y1);
    const midX = cx + (br.x1 + br.x2) / 2 + (br.x2 < br.x1 ? -1.5 : 1.5);
    const midY = baseY + (br.y1 + br.y2) / 2;
    ctx.quadraticCurveTo(midX, midY, cx + br.x2, baseY + br.y2);
    ctx.stroke();
  }
  // Rounded coral tips
  ctx.fillStyle = "#f0a8b0";
  ctx.strokeStyle = "#6e3a44";
  ctx.lineWidth = 0.7;
  for (const e of absoluteEnds) {
    const tipR = e.width * 0.65;
    ctx.beginPath(); ctx.arc(e.x, e.y, tipR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(e.x, e.y, tipR, 0, Math.PI * 2); ctx.stroke();
  }
  // Polyp dots
  ctx.fillStyle = "rgba(110, 58, 68, 0.5)";
  const polyps = [
    { x: cx,                y: baseY - h * 0.15 },
    { x: cx + 2,            y: baseY - h * 0.30 },
    { x: cx - 1,            y: baseY - h * 0.45 },
    { x: cx - maxLat * 0.5, y: baseY - h * 0.70 },
    { x: cx + maxLat * 0.4, y: baseY - h * 0.65 },
  ];
  for (const p of polyps) {
    ctx.beginPath(); ctx.arc(p.x, p.y, 0.8, 0, Math.PI * 2); ctx.fill();
  }
}

function drawSunsetLowBar(ctx: CanvasRenderingContext2D, o: any) {
  // Driftwood log with wood grain, knot detail, and rope wraps.
  const x = o.x, y = o.y, w = o.w, h = o.h;
  // Shadow on sand
  ctx.fillStyle = "rgba(100, 60, 30, 0.30)";
  ctx.fillRect(x + 2, y + h + 2, w - 4, 3);
  // Soft warm glow
  const halo = ctx.createRadialGradient(x + w / 2, y + h / 2, w * 0.2, x + w / 2, y + h / 2, w * 0.8);
  halo.addColorStop(0, "rgba(232, 180, 140, 0.20)");
  halo.addColorStop(1, "rgba(232, 180, 140, 0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w * 0.8, h * 1.8, 0, 0, Math.PI * 2); ctx.fill();
  // Log body
  const logGrad = ctx.createLinearGradient(0, y, 0, y + h);
  logGrad.addColorStop(0, "#f0d6b0");
  logGrad.addColorStop(0.5, "#d9b896");
  logGrad.addColorStop(1, "#a08060");
  ctx.fillStyle = logGrad;
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
  // Outline
  ctx.strokeStyle = "#704830";
  ctx.lineWidth = 0.9;
  ctx.stroke();
  // Wavy wood grain
  ctx.strokeStyle = "rgba(110, 70, 40, 0.4)";
  ctx.lineWidth = 0.7;
  for (let i = 0; i < 3; i++) {
    const gy = y + 4 + i * (h - 8) / 2;
    ctx.beginPath();
    ctx.moveTo(x + 4, gy);
    ctx.quadraticCurveTo(x + w * 0.3, gy + 0.5, x + w * 0.55, gy);
    ctx.quadraticCurveTo(x + w * 0.8, gy - 0.5, x + w - 4, gy);
    ctx.stroke();
  }
  // Knot detail
  ctx.fillStyle = "#5a3820";
  ctx.beginPath(); ctx.ellipse(x + w * 0.35, y + h / 2, 2.5, 1.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#3a2410";
  ctx.beginPath(); ctx.ellipse(x + w * 0.35, y + h / 2, 1.2, 0.7, 0, 0, Math.PI * 2); ctx.fill();
  // Rope wraps - two vertical strokes per end
  ctx.strokeStyle = "#7a5030";
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(x + 4, y + 1); ctx.lineTo(x + 4, y + h - 1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + 7, y + 1); ctx.lineTo(x + 7, y + h - 1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w - 4, y + 1); ctx.lineTo(x + w - 4, y + h - 1); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + w - 7, y + 1); ctx.lineTo(x + w - 7, y + h - 1); ctx.stroke();
  // Rope twist accents
  ctx.strokeStyle = "rgba(60, 40, 20, 0.5)";
  ctx.lineWidth = 0.5;
  for (let i = 0; i < 4; i++) {
    const ry = y + 3 + i * 4;
    ctx.beginPath(); ctx.moveTo(x + 3, ry); ctx.lineTo(x + 8, ry + 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - 8, ry + 0.5); ctx.lineTo(x + w - 3, ry); ctx.stroke();
  }
  // Top highlight
  ctx.fillStyle = "rgba(255, 240, 220, 0.40)";
  ctx.fillRect(x + 10, y + 1, w - 20, 1.5);
}

const sunsetStyle: ObstacleStyle = {
  id: "sunset",
  name: "Sunset",
  description: "Branching coral pillars and weathered driftwood logs.",
  drawFork: drawSunsetFork,
  drawLowBar: drawSunsetLowBar,
};

// Add new obstacle styles here. Each one needs its own drawFork + drawLowBar
// pair. The CosmeticsModal will pick them up automatically and render a
// tile per entry.
export const OBSTACLE_STYLES: ObstacleStyle[] = [defaultStyle, hanamiStyle, sunsetStyle];

export function getObstacleStyleById(id: string): ObstacleStyle {
  return OBSTACLE_STYLES.find(s => s.id === id) ?? OBSTACLE_STYLES[0];
}