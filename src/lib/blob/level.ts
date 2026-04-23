// @ts-nocheck
import { mkPrng } from "./chain";
import { CW, CH, GY } from "./constants";
import blobSprite from "@/assets/blob-sprite.png";

export const TYMAP = { low: GY - 52, mid: GY - 94, high: GY - 140 };

export function generateLevel(seed) {
  const rng = mkPrng(seed);
  const obstacles = [], tokens = [];
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
export const _blobImg: HTMLImageElement | null = (() => {
  if (typeof window === "undefined") return null;
  const img = new Image();
  img.src = blobSprite;
  return img;
})();

export function drawBG(ctx, frame, nodes) {
  const sky = ctx.createLinearGradient(0, 0, 0, GY);
  sky.addColorStop(0, "#070b18");
  sky.addColorStop(1, "#0a1828");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CW, GY);

  const halo = ctx.createRadialGradient(CW / 2, GY, 10, CW / 2, GY, CW * 0.7);
  halo.addColorStop(0, "rgba(0, 255, 204, 0.10)");
  halo.addColorStop(1, "rgba(0, 255, 204, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, CW, GY);

  nodes.forEach(n => {
    ctx.save();
    ctx.globalAlpha = n.a;
    ctx.fillStyle = "#7ad9c5";
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  const gg = ctx.createLinearGradient(0, GY, 0, CH);
  gg.addColorStop(0, "#0d2233");
  gg.addColorStop(1, "#04080f");
  ctx.fillStyle = gg;
  ctx.fillRect(0, GY, CW, CH - GY);

  ctx.save();
  ctx.strokeStyle = "rgba(0, 255, 204, 0.08)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i++) {
    const yy = GY + ((i * 14 + frame * 1.5) % (CH - GY));
    ctx.beginPath();
    ctx.moveTo(0, yy);
    ctx.lineTo(CW, yy);
    ctx.stroke();
  }
  ctx.restore();

  ctx.save();
  ctx.shadowColor = "#00ffcc";
  ctx.shadowBlur = 8;
  ctx.strokeStyle = "rgba(0, 255, 204, 0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, GY);
  ctx.lineTo(CW, GY);
  ctx.stroke();
  ctx.restore();
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
    ctx.save();
    ctx.fillStyle = `rgba(0, 0, 0, ${0.25 - Math.abs(floatY) * 0.015})`;
    ctx.beginPath();
    ctx.ellipse(0, baseH * 0.55 + 6, baseW * 0.32, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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

export function drawFork(ctx, o) {
  ctx.save();
  const cx = o.x + o.w / 2;
  const grad = ctx.createLinearGradient(cx, o.y, cx, o.y + o.h);
  grad.addColorStop(0, "rgba(255, 90, 110, 0.95)");
  grad.addColorStop(1, "rgba(255, 90, 110, 0.55)");
  ctx.shadowColor = "#ff5a6e";
  ctx.shadowBlur = 18;
  ctx.fillStyle = grad;
  const r = 6;
  const x = cx - 7, y = o.y, w = 14, h = o.h;
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
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x + 2, y + 4, 2, h - 8);
  ctx.restore();
}

export function drawLowBar(ctx, o) {
  ctx.save();
  const x = o.x, y = o.y, w = o.w, h = o.h;
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, "rgba(96, 200, 255, 0.95)");
  grad.addColorStop(1, "rgba(40, 120, 230, 0.75)");
  ctx.shadowColor = "#40c4ff";
  ctx.shadowBlur = 18;
  ctx.fillStyle = grad;
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
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.28)";
  for (let i = 4; i < w - 4; i += 10) {
    ctx.fillRect(x + i, y + 4, 4, h - 8);
  }
  ctx.strokeStyle = "rgba(120, 220, 255, 0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 6, y); ctx.lineTo(x + 6, y - 28);
  ctx.moveTo(x + w - 6, y); ctx.lineTo(x + w - 6, y - 28);
  ctx.stroke();
  ctx.restore();
}

export function drawToken(ctx, tx, ty, frame) {
  const p = Math.sin(frame * .08 + tx * .009) * 2.5;
  ctx.save();
  ctx.translate(tx, ty + p);
  const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 18);
  grad.addColorStop(0, "rgba(120, 200, 255, 0.6)");
  grad.addColorStop(1, "rgba(120, 200, 255, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = "#5fb8ff";
  ctx.shadowBlur = 14;
  const coin = ctx.createLinearGradient(0, -12, 0, 12);
  coin.addColorStop(0, "#a9dcff");
  coin.addColorStop(1, "#3a96e6");
  ctx.fillStyle = coin;
  ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#062338";
  ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("Ƀ", 0, 1);
  ctx.restore();
}
