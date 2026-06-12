// Player skin registry. Each skin provides a `draw(ctx, x, y, action, wob, sq, ghost)`
// function with the same signature as the existing `drawBlob` in level.ts so
// the game loop can swap one for another without any other changes.
//
// Action values: "run" | "jump" | "duck"
// wob: animation phase counter (frame-based)
// sq:  vertical squash factor (0..1 ish; 0.5 on hard landings)
// ghost: render as a faded ghost (used for trail rendering)
//
// `trailImage` is the HTMLImageElement used by the game loop's trail
// rendering pass (faded copies of the sprite trailing behind the live
// player). Per-skin so each character trails itself, not the default blob.

import { _blobImg, drawBlob as drawBlobDefault } from "./level";
import ninjaSpritePath from "@/assets/blob-ninja-sprite.png";
import chibiSpritePath from "@/assets/blob-chibi-sprite.png";

export type SkinDraw = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  action: string,
  wob: number,
  sq: number,
  ghost: boolean,
) => void;

export type Skin = {
  id: string;
  name: string;
  description: string;
  draw: SkinDraw;
  // Image used for the trail / after-image pass. Each skin owns its own
  // trail image so the ghost echo behind the player matches the skin.
  // May be null (SSR / image still loading) - the trail draw should
  // null-check before painting.
  trailImage: HTMLImageElement | null;
};

// ---------- Default (the original blob sprite) -----------------------
const defaultSkin: Skin = {
  id: "default",
  name: "Default",
  description: "The classic blob.",
  draw: drawBlobDefault,
  trailImage: _blobImg,
};

// ---------- Ninja sprite loader --------------------------------------
//
// Same pattern as `_blobImg` in level.ts: load once at module init,
// surface failures via a console warning so a missing/corrupt asset
// doesn't crash the game - we just fall back to the colored ellipse
// in the draw function.
let _ninjaFailed = false;
const _ninjaImg: HTMLImageElement | null = (() => {
  if (typeof window === "undefined") return null;
  const img = new Image();
  img.onerror = () => {
    _ninjaFailed = true;
    console.warn("[skin:ninja] sprite failed to load, falling back to ellipse");
  };
  img.onload = () => {
    if (img.naturalWidth === 0) {
      _ninjaFailed = true;
      console.warn("[skin:ninja] sprite loaded but has zero dimensions");
    }
  };
  img.src = ninjaSpritePath;
  return img;
})();

// Ninja draw function. Mirrors drawBlob in level.ts byte-for-byte except
// for the sprite reference and the fallback colour: shadow under the
// player when not ducking, blob-relative float, vertical squash on
// landing. Hitbox dimensions match the default so consensus replay
// stays identical (the sim doesn't see the sprite, only the hitbox).
function drawNinja(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  action: string,
  wob: number,
  sq: number,
  _blink: boolean,
) {
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

  if (_ninjaImg && _ninjaImg.complete && _ninjaImg.naturalWidth > 0 && !_ninjaFailed) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_ninjaImg, -baseW / 2, -baseH / 2, baseW, baseH);
  } else {
    // Fallback: cyan-tinted ellipse so the player can still see something
    // while the sprite loads (or if it fails outright).
    ctx.fillStyle = "#3da9ff";
    ctx.beginPath();
    ctx.ellipse(0, 0, baseW * 0.4, baseH * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

const ninjaSkin: Skin = {
  id: "ninja",
  name: "Ninja",
  description: "Stealth-mode blob with a cyan glow.",
  draw: drawNinja,
  trailImage: _ninjaImg,
};

// ---------- Chibi sprite loader --------------------------------------
let _chibiFailed = false;
const _chibiImg: HTMLImageElement | null = (() => {
  if (typeof window === "undefined") return null;
  const img = new Image();
  img.onerror = () => {
    _chibiFailed = true;
    console.warn("[skin:chibi] sprite failed to load, falling back to ellipse");
  };
  img.onload = () => {
    if (img.naturalWidth === 0) {
      _chibiFailed = true;
      console.warn("[skin:chibi] sprite loaded but has zero dimensions");
    }
  };
  img.src = chibiSpritePath;
  return img;
})();

// Chibi draw function. Same skeleton as drawNinja / drawBlob: shadow
// under the player when not ducking, sine float, vertical squash on
// landing. Hitbox dimensions match the default for consensus parity.
function drawChibi(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  action: string,
  wob: number,
  sq: number,
  _blink: boolean,
) {
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

  if (_chibiImg && _chibiImg.complete && _chibiImg.naturalWidth > 0 && !_chibiFailed) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(_chibiImg, -baseW / 2, -baseH / 2, baseW, baseH);
  } else {
    // Fallback: pink-tinted ellipse so the player can still see something
    // while the sprite loads (or if it fails outright).
    ctx.fillStyle = "#f4a8c0";
    ctx.beginPath();
    ctx.ellipse(0, 0, baseW * 0.4, baseH * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

const chibiSkin: Skin = {
  id: "chibi",
  name: "Chibi",
  description: "Soft pastel pink blob with a flower charm.",
  draw: drawChibi,
  trailImage: _chibiImg,
};

// Add new skin entries above and include them in this list. Each one
// needs its own draw function and trailImage. The CosmeticsModal will
// pick them up automatically and render a tile per entry.
export const SKINS: Skin[] = [defaultSkin, ninjaSkin, chibiSkin];

export function getSkinById(id: string): Skin {
  return SKINS.find(s => s.id === id) ?? SKINS[0];
}