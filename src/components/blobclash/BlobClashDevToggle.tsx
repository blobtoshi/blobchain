// BlobClash — Phase 0 dev viewer.
//
// Renders the deterministic engine to a canvas with bots playing, so you can
// watch the new game run end-to-end. Gated behind a dev access code so it's
// not visible to normal users while in development.
//
// Integration: render <BlobClashDevToggle> above the existing BlobRun game.
// Enter the access code once to unlock; it persists in component state for
// the session (NOT localStorage — artifacts/this app shouldn't rely on it,
// and we want it gone on refresh anyway during dev).
//
// When Phase 0 is signed off, delete this file + the toggle and swap BlobRun
// for the real networked BlobClash.

import { useEffect, useRef, useState } from "react";
import {
  MAP_TILES, TILE_WALL, TILE_BASE, GAMEPLAY_TICKS, TICKS_PER_SEC,
  fpToTile, COIN_COUNT,
} from "@/lib/blobclash/constants";
import { initState, tick, finalScore, lobbyWinner, type ClashState } from "@/lib/blobclash/engine";
import { allBotInputs } from "@/lib/blobclash/bots";
import BlobClashPlayer from "./BlobClashPlayer";
import BlobClashPlayer3D from "./BlobClashPlayer3D";

const DEV_CODE = "blobdev9753";

// Distinct color per player slot.
const PLAYER_COLORS = [
  "#ff5c7a", "#34d399", "#60a5fa", "#fbbf24", "#a78bfa",
  "#f472b6", "#22d3ee", "#fb923c", "#4ade80", "#e879f9",
];

function ClashCanvas({ seed }: { seed: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<ClashState | null>(null);
  const rafRef = useRef<number>(0);
  const [status, setStatus] = useState("running");
  const [standings, setStandings] = useState<{ idx: number; score: number }[]>([]);

  useEffect(() => {
    const cvs = canvasRef.current!;
    const ctx = cvs.getContext("2d")!;
    const TILE_PX = cvs.width / MAP_TILES;
    const st = initState(seed, 10);
    stateRef.current = st;
    let running = true;

    // Run the sim at TICKS_PER_SEC but render every frame.
    let acc = 0;
    let last = performance.now();

    function draw() {
      const s = stateRef.current!;
      // Background
      ctx.fillStyle = "#0a0d14";
      ctx.fillRect(0, 0, cvs.width, cvs.height);
      // Tiles
      for (let y = 0; y < MAP_TILES; y++) {
        for (let x = 0; x < MAP_TILES; x++) {
          const t = s.world.tiles[y * MAP_TILES + x];
          if (t === TILE_WALL) {
            ctx.fillStyle = "#1f2a3d";
            ctx.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
          } else if (t === TILE_BASE) {
            ctx.fillStyle = "#2d3a52";
            ctx.fillRect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX);
          }
        }
      }
      // Base ownership rings
      for (let i = 0; i < s.world.bases.length; i++) {
        const b = s.world.bases[i];
        ctx.strokeStyle = PLAYER_COLORS[i];
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(b.x * TILE_PX - TILE_PX, b.y * TILE_PX - TILE_PX, TILE_PX * 3, TILE_PX * 3);
        ctx.globalAlpha = 1;
      }
      // Coins
      ctx.fillStyle = "#ffd24a";
      for (const c of s.world.coins) {
        if (c.taken) continue;
        ctx.beginPath();
        ctx.arc(c.x * TILE_PX + TILE_PX / 2, c.y * TILE_PX + TILE_PX / 2, TILE_PX * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
      // Dropped coins (slightly redder)
      ctx.fillStyle = "#ffae3a";
      for (const dc of s.droppedCoins) {
        if (dc.amount <= 0) continue;
        ctx.beginPath();
        ctx.arc(dc.tx * TILE_PX + TILE_PX / 2, dc.ty * TILE_PX + TILE_PX / 2, TILE_PX * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
      // Traps
      ctx.fillStyle = "rgba(120, 220, 140, 0.5)";
      for (const tr of s.traps) {
        ctx.fillRect(tr.tx * TILE_PX, tr.ty * TILE_PX, TILE_PX, TILE_PX);
      }
      // Projectiles
      ctx.fillStyle = "#8ef0a8";
      for (const pr of s.projectiles) {
        ctx.beginPath();
        ctx.arc(fpToTile(pr.x) * TILE_PX + TILE_PX / 2, fpToTile(pr.y) * TILE_PX + TILE_PX / 2, TILE_PX * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      // Players
      for (const p of s.players) {
        if (!p.alive) continue;
        const px = fpToTile(p.x) * TILE_PX + TILE_PX / 2;
        const py = fpToTile(p.y) * TILE_PX + TILE_PX / 2;
        // Invincibility halo
        if (s.tick < p.invincibleUntilTick) {
          ctx.strokeStyle = "rgba(255,255,255,0.7)";
          ctx.beginPath(); ctx.arc(px, py, TILE_PX * 1.1, 0, Math.PI * 2); ctx.stroke();
        }
        // Slowed tint
        if (s.tick < p.slowedUntilTick) {
          ctx.fillStyle = "rgba(120,220,140,0.4)";
          ctx.beginPath(); ctx.arc(px, py, TILE_PX * 1.0, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = PLAYER_COLORS[p.idx];
        ctx.beginPath(); ctx.arc(px, py, TILE_PX * 0.7, 0, Math.PI * 2); ctx.fill();
        // Health bar
        ctx.fillStyle = "#000"; ctx.globalAlpha = 0.5;
        ctx.fillRect(px - TILE_PX, py - TILE_PX * 1.3, TILE_PX * 2, TILE_PX * 0.3);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#5dd35d";
        ctx.fillRect(px - TILE_PX, py - TILE_PX * 1.3, TILE_PX * 2 * (p.health / 100), TILE_PX * 0.3);
      }
    }

    function loop(now: number) {
      if (!running) return;
      const dt = now - last; last = now;
      acc += dt;
      const tickMs = 1000 / TICKS_PER_SEC;
      while (acc >= tickMs && st.tick < GAMEPLAY_TICKS) {
        tick(st, allBotInputs(st));
        acc -= tickMs;
      }
      draw();
      if (st.tick >= GAMEPLAY_TICKS) {
        running = false;
        const w = lobbyWinner(st);
        setStatus(`finished — winner P${w}`);
        setStandings(
          st.players.map(p => ({ idx: p.idx, score: finalScore(p) })).sort((a, b) => b.score - a.score),
        );
        return;
      }
      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [seed]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
      <canvas
        ref={canvasRef}
        width={640}
        height={640}
        style={{ borderRadius: 8, border: "1px solid #2f3a4d", background: "#0a0d14", maxWidth: "100%" }}
      />
      <div style={{ fontSize: 12, color: "#93a5be" }}>
        BlobClash Phase 0 — {status} · {COIN_COUNT} coins · seed {seed.toString(16)}
      </div>
      {standings.length > 0 && (
        <div style={{ fontSize: 12, color: "#cfe0f4", display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
          {standings.slice(0, 5).map((s, i) => (
            <span key={s.idx} style={{ color: PLAYER_COLORS[s.idx] }}>
              #{i + 1} P{s.idx}: {s.score}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function BlobClashDevToggle({ children }: { children?: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState(false);
  const [showClash, setShowClash] = useState(false);
  const [view, setView] = useState<"player3d" | "player2d" | "debug">("player3d");
  const [code, setCode] = useState("");
  const [seed, setSeed] = useState(0xc0ffee);
  const [err, setErr] = useState(false);

  const tryUnlock = () => {
    if (code === DEV_CODE) { setUnlocked(true); setErr(false); }
    else setErr(true);
  };

  return (
    <div>
      {/* Dev bar */}
      <div
        style={{
          display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          padding: "8px 12px", marginBottom: 12, borderRadius: 8,
          background: "#11151c", border: "1px dashed #3a4760", fontSize: 12,
        }}
      >
        <span style={{ color: "#7c8aa3", letterSpacing: "0.08em", textTransform: "uppercase" }}>Dev</span>
        {!unlocked ? (
          <>
            <input
              type="password"
              value={code}
              onChange={(e) => { setCode(e.target.value); setErr(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") tryUnlock(); }}
              placeholder="access code"
              style={{
                background: "#0a0d14", color: "#e8f4ff", border: `1px solid ${err ? "#ff5c7a" : "#2f3a4d"}`,
                borderRadius: 6, padding: "4px 8px", fontSize: 12, outline: "none",
              }}
            />
            <button onClick={tryUnlock} style={btn}>Unlock</button>
            {err && <span style={{ color: "#ff5c7a" }}>nope</span>}
          </>
        ) : (
          <>
            <button onClick={() => setShowClash(false)} style={showClash ? btn : btnActive}>Live (BlobRun)</button>
            <button onClick={() => setShowClash(true)} style={showClash ? btnActive : btn}>BlobClash (P0)</button>
            {showClash && (
              <>
                <span style={{ color: "#3a4760" }}>|</span>
                <button onClick={() => setView("player3d")} style={view === "player3d" ? btnActive : btn}>3D</button>
                <button onClick={() => setView("player2d")} style={view === "player2d" ? btnActive : btn}>2D</button>
                <button onClick={() => setView("debug")} style={view === "debug" ? btnActive : btn}>Debug map</button>
                <button onClick={() => setSeed((s) => (s + 1) >>> 0)} style={btn}>New map</button>
                <span style={{ color: "#7c8aa3" }}>seed {seed.toString(16)}</span>
              </>
            )}
          </>
        )}
      </div>

      {/* Body: clash viewer (3D / 2D / debug) or the existing game (children) */}
      {unlocked && showClash
        ? (view === "player3d" ? <BlobClashPlayer3D seed={seed} />
          : view === "player2d" ? <BlobClashPlayer seed={seed} />
          : <ClashCanvas seed={seed} />)
        : children}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: "#1f2530", color: "#e8f4ff", border: "1px solid #2f3a4d",
  borderRadius: 999, padding: "4px 12px", cursor: "pointer", fontSize: 12,
};
const btnActive: React.CSSProperties = {
  ...btn, background: "#3d7aed", borderColor: "transparent", color: "#fff",
};