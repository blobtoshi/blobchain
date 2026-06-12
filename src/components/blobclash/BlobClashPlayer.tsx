// BlobClash — Phase 0 PLAYER viewer (camera-follow + HUD).
//
// This replaces the whole-map debug view with a player-centric one:
//   - Your blob (player 0) is locked to screen center; the camera scrolls.
//   - You only see a viewport window of the 128^2 map.
//   - An edge indicator points toward your home base when off-screen.
//   - HUD shows carried (stashed) vs banked coins and time remaining.
//   - You control player 0 by keyboard; players 1-9 are bots.
//
// The deterministic engine is unchanged and still authoritative — this is
// purely rendering + a human-input adapter that emits the same packed input
// the network layer will eventually send.

import { useEffect, useRef, useState } from "react";
import {
  MAP_TILES, TILE_WALL, TILE_BASE, TILE_FLOOR, GAMEPLAY_TICKS, TICKS_PER_SEC,
  fpToTile, FP_ONE, COIN_SCORE, BASE_RADIUS,
  packInput, MOVE_NONE, DIR8, SLIME_NONE, SLIME_THROW, SLIME_DROP,
} from "@/lib/blobclash/constants";
import { initState, tick, finalScore, type ClashState } from "@/lib/blobclash/engine";
import { botInput } from "@/lib/blobclash/bots";
import { getCosmetics, subscribeCosmetics } from "@/lib/blob/cosmetics";
import { getSkinById } from "@/lib/blob/skins";

const PLAYER_COLORS = [
  "#ff5c7a", "#34d399", "#60a5fa", "#fbbf24", "#a78bfa",
  "#f472b6", "#22d3ee", "#fb923c", "#4ade80", "#e879f9",
];

// Wide viewport matching the old BlobRun world aspect (780x360 = 13:6).
// We show more tiles horizontally than vertically; tiles stay square.
const CANVAS_W = 780;
const CANVAS_H = 360;
const VIEW_TILES_X = 26;                                  // tiles visible across
const VIEW_TILES_Y = VIEW_TILES_X * (CANVAS_H / CANVAS_W); // 12, keeps tiles square
const HUMAN = 0;                  // player index controlled by keyboard

// Deterministic per-tile hash so decorative variation (which wall is a tree
// vs a rock, grass tint, etc.) is stable frame-to-frame and identical for all
// players. Pure visual — never feeds the sim.
function tileHash(x: number, y: number): number {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}

// ── Decorative tile drawers ──
function drawGroundTile(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, h: number) {
  // Dark mossy ground with subtle per-tile variation for texture.
  const v = h % 5;
  const shades = ["#0e1512", "#101813", "#0d1410", "#111a14", "#0f1611"];
  ctx.fillStyle = shades[v];
  ctx.fillRect(sx, sy, px + 1, px + 1);
  // Occasional grass fleck.
  if (h % 17 === 0) {
    ctx.fillStyle = "rgba(90, 150, 90, 0.18)";
    const fx = sx + (h % 7) / 7 * px;
    const fy = sy + ((h >> 3) % 7) / 7 * px;
    ctx.fillRect(fx, fy, px * 0.12, px * 0.28);
  }
}

function drawTree(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, h: number) {
  const cx = sx + px / 2, cy = sy + px / 2;
  // Trunk
  ctx.fillStyle = "#5c3a26";
  ctx.fillRect(cx - px * 0.08, cy + px * 0.05, px * 0.16, px * 0.4);
  // Canopy — 3 overlapping circles, size varies slightly by hash.
  const r = px * (0.42 + (h % 5) * 0.015);
  const greenBase = ["#2f6b3a", "#357a42", "#2c6537"][h % 3];
  ctx.fillStyle = greenBase;
  ctx.beginPath(); ctx.arc(cx, cy - px * 0.1, r, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx - r * 0.55, cy + px * 0.05, r * 0.75, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(cx + r * 0.55, cy + px * 0.05, r * 0.75, 0, Math.PI * 2); ctx.fill();
  // Highlight
  ctx.fillStyle = "rgba(150, 220, 150, 0.35)";
  ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - px * 0.25, r * 0.4, 0, Math.PI * 2); ctx.fill();
}

function drawRock(ctx: CanvasRenderingContext2D, sx: number, sy: number, px: number, h: number) {
  const cx = sx + px / 2, cy = sy + px / 2;
  const r = px * 0.42;
  // Shadow
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.6, r * 1.0, r * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  // Body — gray, slightly randomized shape via hash
  const g = ["#6b7280", "#5a6470", "#737d88"][h % 3];
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy + r * 0.4);
  ctx.quadraticCurveTo(cx - r * 1.1, cy - r * 0.4, cx - r * 0.3, cy - r * 0.7);
  ctx.quadraticCurveTo(cx + r * 0.5, cy - r * 0.9, cx + r, cy - r * 0.2);
  ctx.quadraticCurveTo(cx + r * 1.05, cy + r * 0.4, cx + r * 0.5, cy + r * 0.5);
  ctx.closePath(); ctx.fill();
  // Top highlight
  ctx.fillStyle = "rgba(220, 225, 235, 0.3)";
  ctx.beginPath(); ctx.ellipse(cx - r * 0.2, cy - r * 0.35, r * 0.4, r * 0.22, -0.3, 0, Math.PI * 2); ctx.fill();
}

function drawCoinShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, px: number, tick: number) {
  const pulse = 1 + 0.08 * Math.sin(tick * 0.15 + cx * 0.05);
  const r = px * 0.32 * pulse;
  // Outer gold
  ctx.fillStyle = "#e0a818";
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  // Inner lighter ring
  ctx.fillStyle = "#ffd24a";
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2); ctx.fill();
  // Shine dot
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.22, 0, Math.PI * 2); ctx.fill();
}

// Map the currently-held movement keys to a DIR8 index (or MOVE_NONE).
function keysToDir(keys: Set<string>): number {
  let dx = 0, dy = 0;
  if (keys.has("w") || keys.has("arrowup")) dy -= 1;
  if (keys.has("s") || keys.has("arrowdown")) dy += 1;
  if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
  if (keys.has("d") || keys.has("arrowright")) dx += 1;
  if (dx === 0 && dy === 0) return MOVE_NONE;
  for (let i = 0; i < 8; i++) if (DIR8[i].dx === dx && DIR8[i].dy === dy) return i;
  return MOVE_NONE;
}

export default function BlobClashPlayer({ seed }: { seed: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ClashState | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const slimeActionRef = useRef<number>(SLIME_NONE);   // set on keydown, consumed per tick
  const lKeyDownAtRef = useRef<number>(0);             // for tap(throw) vs hold(drop)
  const rafRef = useRef<number>(0);
  // Active cosmetic skin sprite for the human player. Synced from the same
  // cosmetics store the runner uses, so the blob you picked shows up here too.
  const skinImgRef = useRef<HTMLImageElement | null>(null);

  // Subscribe to cosmetics so the player's chosen skin sprite is rendered.
  useEffect(() => {
    const apply = () => {
      const cos = getCosmetics();
      const skin = getSkinById(cos.skin);
      // Skins expose a trailImage (the sprite). Fall back to null -> colored
      // circle if the sprite hasn't loaded or the skin has no image.
      skinImgRef.current = skin?.trailImage ?? null;
    };
    apply();
    const unsub = subscribeCosmetics(apply);
    return () => { unsub?.(); };
  }, []);

  const [hud, setHud] = useState({ carried: 0, banked: 0, secsLeft: GAMEPLAY_SECONDS(), alive: true, health: 100 });
  const [status, setStatus] = useState<"playing" | "finished">("playing");
  const [finalStandings, setFinalStandings] = useState<{ idx: number; score: number }[]>([]);

  useEffect(() => {
    const cvs = canvasRef.current!;
    const ctx = cvs.getContext("2d")!;
    const st = initState(seed, 10);
    stateRef.current = st;
    let running = true;
    let acc = 0;
    let last = performance.now();

    // ── Input handlers (player 0) ──
    const HOLD_MS = 180; // L held longer than this = drop, else throw
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysRef.current.add(k);
      if (k === "l" && lKeyDownAtRef.current === 0) lKeyDownAtRef.current = performance.now();
      if (["arrowup","arrowdown","arrowleft","arrowright"," "].includes(k)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysRef.current.delete(k);
      if (k === "l") {
        const held = performance.now() - lKeyDownAtRef.current;
        slimeActionRef.current = held >= HOLD_MS ? SLIME_DROP : SLIME_THROW;
        lKeyDownAtRef.current = 0;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function humanInput(): number {
      const keys = keysRef.current;
      const dir = keysToDir(keys);
      const attack = keys.has("j");
      const steal = keys.has("k");
      const slime = slimeActionRef.current;
      slimeActionRef.current = SLIME_NONE; // consume
      return packInput(dir, attack, steal, slime);
    }

    function allInputs(): number[] {
      return st.players.map((p, i) => (i === HUMAN ? humanInput() : botInput(st, p)));
    }

    // ── Render: camera centered on human player ──
    function draw() {
      const s = stateRef.current!;
      const me = s.players[HUMAN];
      const TILE_PX = cvs.width / VIEW_TILES_X;   // square tiles

      // Camera in tile-space (fractional), centered on me.
      const camX = me.x / FP_ONE - VIEW_TILES_X / 2;
      const camY = me.y / FP_ONE - VIEW_TILES_Y / 2;

      // Ground fill (whole canvas) then per-tile detail.
      ctx.fillStyle = "#0b110d";
      ctx.fillRect(0, 0, cvs.width, cvs.height);

      const worldToScreen = (tileX: number, tileY: number) => ({
        sx: (tileX - camX) * TILE_PX,
        sy: (tileY - camY) * TILE_PX,
      });

      // Visible tile range (+1 margin).
      const minTX = Math.max(0, Math.floor(camX) - 1);
      const maxTX = Math.min(MAP_TILES - 1, Math.ceil(camX + VIEW_TILES_X) + 1);
      const minTY = Math.max(0, Math.floor(camY) - 1);
      const maxTY = Math.min(MAP_TILES - 1, Math.ceil(camY + VIEW_TILES_Y) + 1);

      // Pass 1: ground tiles everywhere (floor + base get ground underneath).
      for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
          const t = s.world.tiles[y * MAP_TILES + x];
          if (t !== TILE_WALL) {
            const { sx, sy } = worldToScreen(x, y);
            drawGroundTile(ctx, sx, sy, TILE_PX, tileHash(x, y));
          }
        }
      }

      // Pass 2: walls as trees / rocks (drawn after ground so canopies layer).
      for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
          if (s.world.tiles[y * MAP_TILES + x] !== TILE_WALL) continue;
          const { sx, sy } = worldToScreen(x, y);
          const h = tileHash(x, y);
          if (h % 10 < 7) drawTree(ctx, sx, sy, TILE_PX, h);
          else drawRock(ctx, sx, sy, TILE_PX, h);
        }
      }

      // Bases — 3x3 platform in owner color with a flag banner at center.
      for (let i = 0; i < s.world.bases.length; i++) {
        const b = s.world.bases[i];
        if (b.x < minTX - 2 || b.x > maxTX + 2 || b.y < minTY - 2 || b.y > maxTY + 2) continue;
        const col = PLAYER_COLORS[i];
        const { sx, sy } = worldToScreen(b.x - BASE_RADIUS, b.y - BASE_RADIUS);
        const sizePx = TILE_PX * (BASE_RADIUS * 2 + 1);
        // Platform fill
        ctx.fillStyle = col;
        ctx.globalAlpha = i === HUMAN ? 0.20 : 0.12;
        ctx.fillRect(sx, sy, sizePx, sizePx);
        ctx.globalAlpha = 1;
        // Inlaid border
        ctx.strokeStyle = col;
        ctx.globalAlpha = i === HUMAN ? 0.9 : 0.5;
        ctx.lineWidth = i === HUMAN ? 2.5 : 1.5;
        ctx.strokeRect(sx + 1, sy + 1, sizePx - 2, sizePx - 2);
        // Corner studs
        ctx.fillStyle = col;
        const stud = TILE_PX * 0.18;
        for (const [cxp, cyp] of [[sx, sy], [sx + sizePx, sy], [sx, sy + sizePx], [sx + sizePx, sy + sizePx]]) {
          ctx.beginPath(); ctx.arc(cxp, cyp, stud, 0, Math.PI * 2); ctx.fill();
        }
        ctx.globalAlpha = 1; ctx.lineWidth = 1;
        // Flag banner at center
        const { sx: fcx, sy: fcy } = worldToScreen(b.x + 0.5, b.y + 0.5);
        const poleH = TILE_PX * 1.1;
        ctx.strokeStyle = "#cfd6e0"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(fcx, fcy + TILE_PX * 0.3); ctx.lineTo(fcx, fcy - poleH); ctx.stroke();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(fcx, fcy - poleH);
        ctx.lineTo(fcx + TILE_PX * 0.7, fcy - poleH + TILE_PX * 0.22);
        ctx.lineTo(fcx, fcy - poleH + TILE_PX * 0.44);
        ctx.closePath(); ctx.fill();
        ctx.lineWidth = 1;
      }

      // Coins
      for (const c of s.world.coins) {
        if (c.taken) continue;
        if (c.x < minTX || c.x > maxTX || c.y < minTY || c.y > maxTY) continue;
        const { sx, sy } = worldToScreen(c.x + 0.5, c.y + 0.5);
        drawCoinShape(ctx, sx, sy, TILE_PX, s.tick);
      }
      // Dropped coins — slightly bigger, redder tint to read as "loot".
      for (const dc of s.droppedCoins) {
        if (dc.amount <= 0) continue;
        if (dc.tx < minTX || dc.tx > maxTX || dc.ty < minTY || dc.ty > maxTY) continue;
        const { sx, sy } = worldToScreen(dc.tx + 0.5, dc.ty + 0.5);
        ctx.fillStyle = "#ffae3a";
        ctx.beginPath(); ctx.arc(sx, sy, TILE_PX * 0.46, 0, Math.PI * 2); ctx.fill();
        drawCoinShape(ctx, sx, sy, TILE_PX, s.tick);
      }
      // Traps
      ctx.fillStyle = "rgba(120, 220, 140, 0.5)";
      for (const tr of s.traps) {
        if (tr.tx < minTX || tr.tx > maxTX || tr.ty < minTY || tr.ty > maxTY) continue;
        const { sx, sy } = worldToScreen(tr.tx, tr.ty);
        ctx.fillRect(sx, sy, TILE_PX, TILE_PX);
      }
      // Projectiles
      ctx.fillStyle = "#8ef0a8";
      for (const pr of s.projectiles) {
        const { sx, sy } = worldToScreen(pr.x / FP_ONE, pr.y / FP_ONE);
        ctx.beginPath(); ctx.arc(sx, sy, TILE_PX * 0.28, 0, Math.PI * 2); ctx.fill();
      }

      // Players
      for (const p of s.players) {
        if (!p.alive) continue;
        const { sx, sy } = worldToScreen(p.x / FP_ONE, p.y / FP_ONE);
        if (sx < -TILE_PX || sx > cvs.width + TILE_PX || sy < -TILE_PX || sy > cvs.height + TILE_PX) continue;
        if (s.tick < p.invincibleUntilTick) {
          ctx.strokeStyle = "rgba(255,255,255,0.8)";
          ctx.beginPath(); ctx.arc(sx, sy, TILE_PX * 0.95, 0, Math.PI * 2); ctx.stroke();
        }
        if (s.tick < p.slowedUntilTick) {
          ctx.fillStyle = "rgba(120,220,140,0.4)";
          ctx.beginPath(); ctx.arc(sx, sy, TILE_PX * 0.9, 0, Math.PI * 2); ctx.fill();
        }

        const img = p.idx === HUMAN ? skinImgRef.current : null;
        if (img && img.complete && img.naturalWidth > 0) {
          // Draw the chosen cosmetic sprite UPRIGHT and screen-facing (no
          // rotation, no direction line). Sprites are drawn side-on for the
          // runner and read cleanly from above when kept upright. Bigger now
          // (~3.4 tiles) so the character has real presence on screen.
          const spriteSz = TILE_PX * 3.4;
          ctx.drawImage(img, sx - spriteSz / 2, sy - spriteSz / 2, spriteSz, spriteSz);
        } else {
          // Bots, or human before sprite loads: colored blob with a little
          // shading so it isn't a flat disc.
          const r = p.idx === HUMAN ? TILE_PX * 1.0 : TILE_PX * 0.7;
          ctx.fillStyle = PLAYER_COLORS[p.idx];
          ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.beginPath(); ctx.arc(sx - r * 0.3, sy - r * 0.3, r * 0.35, 0, Math.PI * 2); ctx.fill();
        }

        // health bar for the human only (keep others clean)
        if (p.idx === HUMAN) {
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(sx - TILE_PX * 1.0, sy - TILE_PX * 2.1, TILE_PX * 2.0, TILE_PX * 0.26);
          ctx.fillStyle = "#5dd35d";
          ctx.fillRect(sx - TILE_PX * 1.0, sy - TILE_PX * 2.1, TILE_PX * 2.0 * (p.health / 100), TILE_PX * 0.26);
        }
      }

      // ── Edge indicator: arrow toward home base when off-screen ──
      const myBase = s.world.bases[HUMAN];
      const baseOnScreen =
        myBase.x >= camX && myBase.x <= camX + VIEW_TILES_X &&
        myBase.y >= camY && myBase.y <= camY + VIEW_TILES_Y;
      if (!baseOnScreen) {
        const meScreenX = cvs.width / 2;
        const meScreenY = cvs.height / 2;
        const { sx: bsx, sy: bsy } = worldToScreen(myBase.x + 0.5, myBase.y + 0.5);
        const ang = Math.atan2(bsy - meScreenY, bsx - meScreenX);
        // Clamp an arrow to a rectangle inset from the edges.
        const pad = 28;
        const hw = cvs.width / 2 - pad;
        const hh = cvs.height / 2 - pad;
        const tdx = Math.cos(ang), tdy = Math.sin(ang);
        // Scale to the rectangle edge.
        const scale = Math.min(
          hw / Math.max(1e-3, Math.abs(tdx)),
          hh / Math.max(1e-3, Math.abs(tdy)),
        );
        const ax = meScreenX + tdx * scale;
        const ay = meScreenY + tdy * scale;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(ang);
        ctx.fillStyle = PLAYER_COLORS[HUMAN];
        ctx.beginPath();
        ctx.moveTo(14, 0); ctx.lineTo(-8, -9); ctx.lineTo(-8, 9);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        // "HOME" label near the arrow
        ctx.fillStyle = PLAYER_COLORS[HUMAN];
        ctx.font = "bold 10px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        const lx = meScreenX + tdx * (scale - 20);
        const ly = meScreenY + tdy * (scale - 20);
        ctx.fillText("HOME", lx, ly);
      }
    }

    function loop(now: number) {
      if (!running) return;
      const dt = now - last; last = now;
      acc += dt;
      const tickMs = 1000 / TICKS_PER_SEC;
      while (acc >= tickMs && st.tick < GAMEPLAY_TICKS) {
        tick(st, allInputs());
        acc -= tickMs;
      }
      draw();
      // HUD update
      const me = st.players[HUMAN];
      const secsLeft = Math.max(0, Math.ceil((GAMEPLAY_TICKS - st.tick) / TICKS_PER_SEC));
      setHud({ carried: me.carried, banked: me.banked, secsLeft, alive: me.alive, health: me.health });

      if (st.tick >= GAMEPLAY_TICKS) {
        running = false;
        setStatus("finished");
        setFinalStandings(
          st.players.map(p => ({ idx: p.idx, score: finalScore(p) })).sort((a, b) => b.score - a.score),
        );
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [seed]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
      {/* HUD bar */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", fontSize: 13, color: "#cfe0f4", flexWrap: "wrap", justifyContent: "center" }}>
        <span style={{ color: "#ffd24a" }}>● Stashed: <b>{hud.carried}</b></span>
        <span style={{ color: "#5dd35d" }}>▣ Banked: <b>{hud.banked}</b></span>
        <span style={{ color: "#cfe0f4" }}>Score: <b>{hud.banked * COIN_SCORE}</b></span>
        <span style={{ color: hud.secsLeft <= 15 ? "#ff5c7a" : "#93a5be" }}>⏱ {hud.secsLeft}s</span>
        {!hud.alive && <span style={{ color: "#ff5c7a" }}>respawning…</span>}
      </div>

      <div style={{ position: "relative" }}>
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ borderRadius: 8, border: "1px solid #2f3a4d", background: "#0a0d14", maxWidth: "100%", display: "block" }}
        />
        {status === "finished" && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(8,11,18,0.88)", borderRadius: 8,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e8f4ff" }}>
              {finalStandings[0]?.idx === HUMAN ? "You win the lobby! 🏆" : `Lobby winner: P${finalStandings[0]?.idx}`}
            </div>
            {finalStandings.slice(0, 5).map((s, i) => (
              <div key={s.idx} style={{ fontSize: 12, color: s.idx === HUMAN ? "#ffd24a" : PLAYER_COLORS[s.idx] }}>
                #{i + 1} {s.idx === HUMAN ? "YOU" : `P${s.idx}`}: {s.score}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Controls legend */}
      <div style={{ fontSize: 11, color: "#7c8aa3", textAlign: "center", lineHeight: 1.6 }}>
        <b>WASD / arrows</b> move · <b>J</b> attack · <b>K</b> steal (on enemy base) · <b>L</b> tap = throw slime, hold = drop trap<br />
        Carry coins to your <span style={{ color: PLAYER_COLORS[HUMAN] }}>home base</span> (follow the HOME arrow) to bank them. Banked coins score; stashed coins don't.
      </div>
    </div>
  );
}

// Small helper so the initial HUD state has the right number without importing
// the constant indirectly (keeps the default render clean before first tick).
function GAMEPLAY_SECONDS(): number {
  return Math.ceil(GAMEPLAY_TICKS / TICKS_PER_SEC);
}