import { mkPrng } from "./chain";
import { CW, CH, GY } from "./constants";
import blobSprite from "@/assets/blob-sprite.png";

export const TYMAP = { low: GY - 52, mid: GY - 94, high: GY - 140 };

export function generateLevel(seed) {
  const rng = mkPrng(seed);
  const obstacles: { at: number; type: string; w: number; h: number }[] = [];
  const tokens: { at: number; height: string }[] = [];
  let pos = 250;
  let idx = 0;
  while (pos < 400000) {
    // Gaps shrink with index — early obstacles feel fair, later they pack tight.
    const tightness = Math.min(idx / 120, 1); // 0 → 1 over first 120 obstacles
    const baseMin = 240 - tightness * 130;    // 240 → 110
    const baseRng = 280 - tightness * 200;    // 280 → 80
    const gap = baseMin + rng() * baseRng;
    pos += gap;
    idx++;
    const r = rng();
    if (r < 0.38) obstacles.push({ at: pos, type: "fork", w: 36, h: 66 });
    else if (r < 0.6) obstacles.push({ at: pos, type: "double", w: 36, h: 66 });
    else if (r < 0.75) obstacles.push({ at: pos, type: "tall", w: 40, h: 90 });
    else obstacles.push({ at: pos, type: "low", w: 60, h: 18 });
    if (rng() < 0.68) {
      const hs = ["low", "mid", "high"];
      tokens.push({ at: pos - gap * 0.4, height: hs[Math.floor(rng() * 3)] });
    }
  }
  return { obstacles, tokens };
}

// Sprite image for the player blob — loaded once at module init.
export let _blobImgFailed = false;
export const _blobImg: HTMLImageElement | null = (() => {
  if (typeof window === "undefined") return null;
  const img = new Image();
  img.onerror = (e) => {
    _blobImgFailed = true;
    console.warn("[blob] sprite failed to load, falling back to ellipse", { src: blobSprite, e });
  };
  img.onload = () => {
    if (img.naturalWidth === 0) {
      _blobImgFailed = true;
      console.warn("[blob] sprite loaded but has zero dimensions", { src: blobSprite });
    }
  };
  img.src = blobSprite;
  return img;
})();

// Cached static gradients — created lazily once per ctx.
let _skyGrad: CanvasGradient | null = null;
let _haloGrad: CanvasGradient | null = null;
let _groundGrad: CanvasGradient | null = null;
let _gradCtx: CanvasRenderingContext2D | null = null;
function ensureBGGrads(ctx: CanvasRenderingContext2D) {
  if (_gradCtx === ctx && _skyGrad && _haloGrad && _groundGrad) return;
  _gradCtx = ctx;
  _skyGrad = ctx.createLinearGradient(0, 0, 0, GY);
  _skyGrad.addColorStop(0, "#070b18");
  _skyGrad.addColorStop(1, "#0a1828");
  _haloGrad = ctx.createRadialGradient(CW / 2, GY, 10, CW / 2, GY, CW * 0.7);
  _haloGrad.addColorStop(0, "rgba(0, 255, 204, 0.10)");
  _haloGrad.addColorStop(1, "rgba(0, 255, 204, 0)");
  _groundGrad = ctx.createLinearGradient(0, GY, 0, CH);
  _groundGrad.addColorStop(0, "#0d2233");
  _groundGrad.addColorStop(1, "#04080f");
}

export function drawBG(ctx: CanvasRenderingContext2D, frame: number, nodes: Array<{x:number;y:number;r:number;a:number}>) {
  ensureBGGrads(ctx);
  ctx.fillStyle = _skyGrad!;
  ctx.fillRect(0, 0, CW, GY);

  ctx.fillStyle = _haloGrad!;
  ctx.fillRect(0, 0, CW, GY);

  ctx.fillStyle = "#7ad9c5";
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    ctx.globalAlpha = n.a;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = _groundGrad!;
  ctx.fillRect(0, GY, CW, CH - GY);

  ctx.strokeStyle = "rgba(0, 255, 204, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const yy = GY + ((i * 14 + frame * 1.5) % (CH - GY));
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(CW, yy);
    ctx.stroke();
  }

  // Horizon line — pre-baked with glow into a strip sprite (avoids per-frame shadowBlur).
  const hl = ensureHorizonStrip();
  if (hl) ctx.drawImage(hl, 0, GY - hl.height / 2);
}

// ---------- Pre-baked sprite cache ----------------------------------------
// Canvas shadowBlur is one of the slowest 2D ops. We render each glowing
// shape ONCE into an offscreen canvas at module init, then drawImage() it
// every frame. Visually identical, ~5-10x faster.

function makeOffscreen(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

let _horizonStrip: HTMLCanvasElement | null = null;
function ensureHorizonStrip(): HTMLCanvasElement | null {
  if (_horizonStrip) return _horizonStrip;
  const PAD = 16;
  const c = makeOffscreen(CW, PAD * 2);
  if (!c) return null;
  const x = c.getContext("2d")!;
  x.shadowColor = "#00ffcc";
  x.shadowBlur = 8;
  x.strokeStyle = "rgba(0, 255, 204, 0.55)";
  x.lineWidth = 1;
  x.beginPath();
  x.moveTo(0, PAD);
  x.lineTo(CW, PAD);
  x.stroke();
  _horizonStrip = c;
  return c;
}

// Fork sprite (red vertical bar with glow). Cached by exact (w, h).
const _forkCache = new Map<string, HTMLCanvasElement>();
function ensureForkSprite(w: number, h: number): HTMLCanvasElement | null {
  const key = `${w}x${h}`;
  const cached = _forkCache.get(key);
  if (cached) return cached;
  const PAD = 22;
  const c = makeOffscreen(w + PAD * 2, h + PAD * 2);
  if (!c) return null;
  const x = c.getContext("2d")!;
  const cx = PAD + w / 2;
  const grad = x.createLinearGradient(cx, PAD, cx, PAD + h);
  grad.addColorStop(0, "rgba(255, 90, 110, 0.95)");
  grad.addColorStop(1, "rgba(255, 90, 110, 0.55)");
  x.shadowColor = "#ff5a6e";
  x.shadowBlur = 18;
  x.fillStyle = grad;
  const r = 6;
  const bx = cx - 7, by = PAD, bw = 14, bh = h;
  x.beginPath();
  x.moveTo(bx + r, by);
  x.lineTo(bx + bw - r, by);
  x.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  x.lineTo(bx + bw, by + bh - r);
  x.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  x.lineTo(bx + r, by + bh);
  x.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
  x.lineTo(bx, by + r);
  x.quadraticCurveTo(bx, by, bx + r, by);
  x.closePath();
  x.fill();
  x.shadowBlur = 0;
  x.fillStyle = "rgba(255,255,255,0.18)";
  x.fillRect(bx + 2, by + 4, 2, bh - 8);
  _forkCache.set(key, c);
  return c;
}

export function drawFork(ctx, o) {
  const sprite = ensureForkSprite(o.w, o.h);
  if (!sprite) return;
  const PAD = 22;
  ctx.drawImage(sprite, o.x - PAD, o.y - PAD);
}

// Low bar sprite. Cached per (w, h).
const _lowBarCache = new Map<string, HTMLCanvasElement>();
function ensureLowBarSprite(w: number, h: number): HTMLCanvasElement | null {
  const key = `${w}x${h}`;
  const cached = _lowBarCache.get(key);
  if (cached) return cached;
  const PAD = 22;
  const TOP = 32; // room for the vertical glow lines extending above the bar
  const c = makeOffscreen(w + PAD * 2, h + PAD + TOP);
  if (!c) return null;
  const x = c.getContext("2d")!;
  const bx = PAD, by = TOP, bw = w, bh = h;
  const grad = x.createLinearGradient(bx, by, bx, by + bh);
  grad.addColorStop(0, "rgba(96, 200, 255, 0.95)");
  grad.addColorStop(1, "rgba(40, 120, 230, 0.75)");
  x.shadowColor = "#40c4ff";
  x.shadowBlur = 18;
  x.fillStyle = grad;
  const r = 6;
  x.beginPath();
  x.moveTo(bx + r, by);
  x.lineTo(bx + bw - r, by);
  x.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  x.lineTo(bx + bw, by + bh - r);
  x.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  x.lineTo(bx + r, by + bh);
  x.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
  x.lineTo(bx, by + r);
  x.quadraticCurveTo(bx, by, bx + r, by);
  x.closePath();
  x.fill();
  x.shadowBlur = 0;
  x.fillStyle = "rgba(255,255,255,0.28)";
  for (let i = 4; i < bw - 4; i += 10) {
    x.fillRect(bx + i, by + 4, 4, bh - 8);
  }
  x.strokeStyle = "rgba(120, 220, 255, 0.35)";
  x.lineWidth = 1;
  x.beginPath();
  x.moveTo(bx + 6, by); x.lineTo(bx + 6, by - 28);
  x.moveTo(bx + bw - 6, by); x.lineTo(bx + bw - 6, by - 28);
  x.stroke();
  _lowBarCache.set(key, c);
  return c;
}

export function drawLowBar(ctx, o) {
  const sprite = ensureLowBarSprite(o.w, o.h);
  if (!sprite) return;
  const PAD = 22;
  const TOP = 32;
  ctx.drawImage(sprite, o.x - PAD, o.y - TOP);
}

// Token sprite — coin + halo + "Ƀ" glyph. One sprite, drawn with vertical bob.
let _tokenSprite: HTMLCanvasElement | null = null;
function ensureTokenSprite(): HTMLCanvasElement | null {
  if (_tokenSprite) return _tokenSprite;
  const SZ = 48; // sprite is 48x48, drawn centered on (tx, ty + bob)
  const c = makeOffscreen(SZ, SZ);
  if (!c) return null;
  const x = c.getContext("2d")!;
  x.translate(SZ / 2, SZ / 2);
  // Outer halo (radial gradient — no shadowBlur needed).
  const halo = x.createRadialGradient(0, 0, 2, 0, 0, 18);
  halo.addColorStop(0, "rgba(120, 200, 255, 0.6)");
  halo.addColorStop(1, "rgba(120, 200, 255, 0)");
  x.fillStyle = halo;
  x.beginPath(); x.arc(0, 0, 18, 0, Math.PI * 2); x.fill();
  // Coin body with one-shot shadow bake.
  x.shadowColor = "#5fb8ff";
  x.shadowBlur = 14;
  const coin = x.createLinearGradient(0, -12, 0, 12);
  coin.addColorStop(0, "#a9dcff");
  coin.addColorStop(1, "#3a96e6");
  x.fillStyle = coin;
  x.beginPath(); x.arc(0, 0, 11, 0, Math.PI * 2); x.fill();
  x.shadowBlur = 0;
  x.fillStyle = "#062338";
  x.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("Ƀ", 0, 1);
  _tokenSprite = c;
  return c;
}

export function drawToken(ctx, tx, ty, frame) {
  const sprite = ensureTokenSprite();
  if (!sprite) return;
  const p = Math.sin(frame * .08 + tx * .009) * 2.5;
  ctx.drawImage(sprite, tx - 24, ty + p - 24);
}

// Pre-baked particle sprite — soft glowing dot. Drawn additively with globalAlpha.
let _particleSprite: HTMLCanvasElement | null = null;
export function ensureParticleSprite(): HTMLCanvasElement | null {
  if (_particleSprite) return _particleSprite;
  const SZ = 32;
  const c = makeOffscreen(SZ, SZ);
  if (!c) return null;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(SZ / 2, SZ / 2, 0, SZ / 2, SZ / 2, SZ / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, SZ, SZ);
  _particleSprite = c;
  return c;
}

export function drawBlob(ctx, x, y, action, wob, sq, _blink) {
  const duck = action === "duck";
  const baseW = duck ? 78 : 64;
  const baseH = duck ? 46 : 72;
  const t = wob * 0.08;
  const floatY = duck ? 0 : Math.sin(t) * 5;
  const floatX = duck ? 0 : Math.sin(t * 0.7) * 1.5;
  ctx.save();
  ctx.translate(x + floatX, y + floatY - (duck ? 0 : 4));
  ctx.scale(1, sq);

  if (!duck) {
    ctx.fillStyle = `rgba(0, 0, 0, ${0.25 - Math.abs(floatY) * 0.015})`;
    ctx.beginPath();
    ctx.ellipse(0, baseH * 0.55 + 6, baseW * 0.32, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (_blobImg && _blobImg.complete && _blobImg.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_blobImg, -baseW / 2, -baseH / 2, baseW, baseH);
  } else {
    ctx.fillStyle = "#3eecbf";
    ctx.beginPath();
    ctx.ellipse(0, 0, baseW * 0.4, baseH * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
