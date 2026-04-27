import { useEffect, useRef, useState, useCallback } from "react";
import * as Relay from "@/lib/blobRelay";
import { signData } from "@/lib/blob/crypto";
import { CW, CH, GY, PX } from "@/lib/blob/constants";
import {
  drawBG, drawBlob, drawFork, drawLowBar, drawToken,
  _blobImg, ensureParticleSprite,
} from "@/lib/blob/level";
import {
  generateLevelPure, initialState, tick,
  encodeInputs, hashInputs, ENGINE_VERSION,
} from "@/lib/blob/simulator";

type InputEv = { f: number; t: number };
type SimState = ReturnType<typeof initialState>;
type Particle = { x: number; y: number; vx: number; vy: number; life: number; col: string; sz: number };
type Trail = { x: number; y: number; action: string };

const TRAIL_LEN = 4;          // was 8 — cuts ~4 per-frame drawImage calls
const MAX_PARTICLES = 96;     // hard cap to bound worst-case allocations

export default function BlobRunGame({ wallet, blockInfo, onEntrySubmit }) {
  const cvs = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef<number | null>(null);
  const stateRef = useRef<SimState | null>(null);
  const inputsRef = useRef<InputEv[]>([]); // recorded events for verifiable replay
  const jRef = useRef(false);
  const dRef = useRef(false);
  const stRef = useRef("idle");
  // Render-only scratch (NOT part of deterministic simulator state).
  const renderRef = useRef<{ trail: Trail[]; lastCombo: number }>({ trail: [], lastCombo: 0 });
  const [gs, setGs] = useState({ status: "idle", score: 0, combo: 0 });

  const level = useRef(generateLevelPure(blockInfo.seed));
  const bgNodes = useRef(Array.from({ length: 12 }, () => ({
    x: Math.random() * CW, y: 20 + Math.random() * (GY - 40),
    r: 2 + Math.random() * 9, a: .03 + Math.random() * .09,
    spd: .25 + Math.random() * .8,
  })));

  useEffect(() => {
    level.current = generateLevelPure(blockInfo.seed);
  }, [blockInfo.seed]);

  // Helper: record a key state change as an input event for the *next* tick.
  const recordEvent = useCallback((type) => {
    const s = stateRef.current;
    if (!s || s.dead) return;
    // Event applies at the tick that's about to run (frame becomes s.frame+1).
    inputsRef.current.push({ f: s.frame + 1, t: type });
  }, []);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        if (!jRef.current) { jRef.current = true; recordEvent(0); }
      }
      if (e.code === "ArrowDown") {
        e.preventDefault();
        if (!dRef.current) { dRef.current = true; recordEvent(2); }
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        if (jRef.current) { jRef.current = false; recordEvent(1); }
      }
      if (e.code === "ArrowDown") {
        e.preventDefault();
        if (dRef.current) { dRef.current = false; recordEvent(3); }
      }
    };
    // Explicit non-passive so preventDefault works without warnings.
    window.addEventListener("keydown", kd, { passive: false });
    window.addEventListener("keyup", ku, { passive: false });
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [recordEvent]);

  // Async submission path — split out so the rAF loop stays synchronous.
  const submitRun = useCallback(async (state: SimState) => {
    const finalScore = state.score;
    const frameCount = state.frame;
    if (finalScore <= 0) return; // anti-Sybil: must clear first obstacle
    const canonical = encodeInputs(inputsRef.current);
    const inputsHash = await hashInputs(canonical);
    const payload = `${blockInfo.height}:${wallet.address}:${finalScore}:${inputsHash}`;
    const sig = await signData(wallet.privateKey, payload);
    const entry = {
      block_height: blockInfo.height,
      block_seed: String(blockInfo.seed),
      address: wallet.address,
      score: finalScore,
      frame_count: frameCount,
      inputs: canonical,
      inputs_hash: inputsHash,
      engine_version: ENGINE_VERSION,
      signature: sig,
      submitted_at: new Date().toISOString(),
    };
    Relay.pushEntry({ ...entry, publicKey: wallet.publicKey });
    onEntrySubmit(entry);
  }, [blockInfo, wallet, onEntrySubmit]);

  const startRun = useCallback(() => {
    if (raf.current != null) cancelAnimationFrame(raf.current);
    jRef.current = false; dRef.current = false;
    stRef.current = "playing";
    inputsRef.current = [];
    renderRef.current = { trail: [], lastCombo: 0 };
    const lev = level.current;
    const state = initialState();
    stateRef.current = state;
    setGs({ status: "playing", score: 0, combo: 0 });

    const canvas = cvs.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    // Set once per run instead of every frame.
    ctx.imageSmoothingEnabled = false;

    // ---- Particle pool ----
    // Pre-allocate fixed-size pool; never splice, never push at runtime.
    // life <= 0 means slot is free for reuse.
    const parts: Particle[] = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      parts[i] = { x: 0, y: 0, vx: 0, vy: 0, life: 0, col: "", sz: 0 };
    }
    const particleSprite = ensureParticleSprite();

    function spawnParts(x: number, y: number, col: string, n = 8) {
      let placed = 0;
      for (let i = 0; i < MAX_PARTICLES && placed < n; i++) {
        const pt = parts[i];
        if (pt.life > 0) continue;
        pt.x = x; pt.y = y;
        pt.vx = (Math.random() - .5) * 9;
        pt.vy = Math.random() * -9 - 2;
        pt.life = 1;
        pt.col = col;
        pt.sz = 2 + Math.random() * 4.5;
        placed++;
      }
    }

    function roundedRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    // ---- HUD chrome cache ----
    // The static parts of the HUD (rounded panel, "SCORE"/"BLOCK"/"SPEED"
    // labels, the block #) don't change frame-to-frame. Bake them once into
    // an offscreen canvas and blit each frame instead of redrawing all paths.
    const FNT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif';
    const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    const hudCache = document.createElement("canvas");
    hudCache.width = CW; hudCache.height = 56;
    {
      const h = hudCache.getContext("2d")!;
      h.fillStyle = "rgba(7, 12, 22, 0.55)";
      roundedRect(h, 12, 10, CW - 24, 38, 12);
      h.fill();
      h.strokeStyle = "rgba(125, 255, 224, 0.10)";
      h.lineWidth = 1;
      h.stroke();
      h.fillStyle = "rgba(180, 220, 230, 0.45)";
      h.font = `9px ${FNT}`;
      h.textAlign = "left";  h.fillText("SCORE", 26, 24);
      h.textAlign = "center"; h.fillText(`BLOCK #${blockInfo.height}`, CW / 2, 24);
      h.textAlign = "right"; h.fillText(`SPEED`, CW - 26, 24);
      h.fillStyle = "#7dffe0";
      h.font = `600 18px ${MONO}`;
      h.textAlign = "center"; h.fillText(`#${blockInfo.height}`, CW / 2, 42);
    }

    // Cache score string allocations: only re-format when score changes.
    let lastScore = -1;
    let scoreStr = "0";

    function drawHUD() {
      ctx.drawImage(hudCache, 0, 0);

      if (state.score !== lastScore) {
        lastScore = state.score;
        scoreStr = state.score.toLocaleString();
      }

      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 18px ${MONO}`;
      ctx.textAlign = "left";
      ctx.fillText(scoreStr, 26, 42);

      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.fillText(`SPEED ×${state.speed.toFixed(1)}`, CW - 26, 24);
      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 14px ${MONO}`;
      ctx.fillText(`${blockInfo.reward} BLOB`, CW - 26, 42);

      if (state.combo > 1) {
        ctx.textAlign = "left";
        // No shadowBlur — keep glow effect via additive overdraw.
        ctx.fillStyle = "#ffd166";
        ctx.font = `700 ${Math.min(13 + state.combo * 2, 26)}px ${FNT}`;
        ctx.fillText(`×${state.combo} combo`, 26, CH - 24);
      }
      if (state.locked) {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(7, 12, 22, 0.6)";
        roundedRect(ctx, CW / 2 - 180, CH - 36, 360, 24, 12);
        ctx.fill();
        ctx.fillStyle = "#7dffe0";
        ctx.font = `600 10px ${FNT}`;
        ctx.fillText("✓ Replay submitted — awaiting node verification", CW / 2, CH - 20);
      }
    }

    // Pre-allocated trail ring buffer — reused, never re-created.
    const trailBuf: Trail[] = new Array(TRAIL_LEN);
    for (let i = 0; i < TRAIL_LEN; i++) trailBuf[i] = { x: 0, y: 0, action: "" };
    let trailHead = 0;     // index of newest entry
    let trailCount = 0;    // 0..TRAIL_LEN

    function drawTrailAndBlob() {
      const p = state.player;
      if (!state.locked && p.action !== "dead" && _blobImg && _blobImg.complete && _blobImg.naturalWidth > 0) {
        const tT = p.wob * 0.08;
        const trailFloatY = p.action === "duck" ? 0 : Math.sin(tT) * 5;
        // Advance head, mutate slot in place.
        trailHead = (trailHead + TRAIL_LEN - 1) % TRAIL_LEN;
        const slot = trailBuf[trailHead];
        slot.x = PX;
        slot.y = p.y + trailFloatY - (p.action === "duck" ? 0 : 4);
        slot.action = p.action;
        if (trailCount < TRAIL_LEN) trailCount++;
        const duck = p.action === "duck";
        const baseW = duck ? 78 : 64;
        const baseH = duck ? 46 : 72;
        // Single save/restore around the whole trail; no per-step composite changes.
        ctx.save();
        for (let i = trailCount - 1; i >= 1; i--) {
          const tr = trailBuf[(trailHead + i) % TRAIL_LEN];
          ctx.globalAlpha = (1 - i / trailCount) * 0.28;
          ctx.setTransform(1, 0, 0, p.sq, tr.x - i * 6, tr.y);
          ctx.drawImage(_blobImg, -baseW / 2, -baseH / 2, baseW, baseH);
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.restore();
      } else {
        trailCount = 0;
      }
    }

    function draw() {
      const p = state.player;
      const nodes = bgNodes.current;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.x -= n.spd;
        if (n.x < -15) n.x = CW + 15;
      }
      drawBG(ctx, state.frame, nodes);

      drawTrailAndBlob();

      const obs = state.obstacles;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (o.type === "low") drawLowBar(ctx, o); else drawFork(ctx, o);
      }
      const tks = state.tokens;
      for (let i = 0; i < tks.length; i++) {
        const t = tks[i];
        if (t.alive) drawToken(ctx, t.x, t.y, state.frame);
      }

      // Particles — pre-baked sprite, no per-particle shadowBlur.
      // Pool: iterate full fixed-size array, skip dead slots (life <= 0).
      if (particleSprite) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < MAX_PARTICLES; i++) {
          const pt = parts[i];
          if (pt.life <= 0) continue;
          ctx.globalAlpha = pt.life;
          const s = pt.sz * 2;
          ctx.drawImage(particleSprite, pt.x - s, pt.y - s, s * 2, s * 2);
        }
        ctx.restore();
      }

      if (!state.dead) drawBlob(ctx, PX, p.y, p.action, p.wob, p.sq, false);
      drawHUD();
    }

    function loop() {
      if (stRef.current !== "playing") return;
      // Collect events queued for the upcoming tick (recordEvent appends with
      // f = state.frame + 1, so they live at the tail of inputsRef).
      const targetFrame = state.frame + 1;
      const queuedAtFrame: InputEv[] = [];
      for (let i = inputsRef.current.length - 1; i >= 0 && inputsRef.current[i].f === targetFrame; i--) {
        queuedAtFrame.unshift(inputsRef.current[i]);
      }

      const alive = tick(state, lev, queuedAtFrame);

      // Visual-only: pickup particles based on the simulator's per-frame counter
      // (no array .filter() allocations).
      const pickedThisFrame = state.tokensPickedThisFrame;
      if (pickedThisFrame > 0) {
        spawnParts(PX, state.player.y, "#00aaff", 8 * pickedThisFrame);
      }

      if (!alive) {
        spawnParts(PX, state.player.y, "#ff2244", 18);
        spawnParts(PX, state.player.y, "#00ffcc", 8);
        stRef.current = "dead";
        const finalScore = state.score;
        // Coalesced state update.
        setGs({ status: "dead", score: finalScore, combo: 0 });
        renderRef.current.lastCombo = 0;
        // Update particles one last time for the fade-out frame (pool, no splice).
        for (let i = 0; i < MAX_PARTICLES; i++) {
          const pt = parts[i];
          if (pt.life <= 0) continue;
          pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028;
        }
        draw();
        // Fire-and-forget submission — keeps loop sync.
        void submitRun(state);
        return;
      }

      // Particle physics — pool, never splice. Dead slots are reusable.
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const pt = parts[i];
        if (pt.life <= 0) continue;
        pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028;
      }

      draw();
      // Combo only changes on token pickup (up) or simulator-side reset (which
      // happens at obstacle hit = death, handled above). Skip the per-frame
      // compare; only check when a pickup just occurred.
      // Combo only changes meaningfully in two cases:
      //   1) token pickup (increment) → pickedThisFrame > 0
      //   2) timer expiry resets to 0  → cheap zero-check vs cached lastCombo
      // Both are O(1) and avoid the per-frame compare-on-every-tick we had.
      const lastCombo = renderRef.current.lastCombo;
      if (
        (pickedThisFrame > 0 && state.combo !== lastCombo) ||
        (lastCombo > 0 && state.combo === 0)
      ) {
        renderRef.current.lastCombo = state.combo;
        setGs(prev => ({ ...prev, score: state.score, combo: state.combo }));
      }
      raf.current = requestAnimationFrame(loop);
    }

    raf.current = requestAnimationFrame(loop);
  }, [blockInfo, submitRun]);

  useEffect(() => {
    startRun();
    return () => { if (raf.current != null) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tap = press jump. Release happens on touch end (variable-height jump).
  const onTapStart = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    if (gs.status === "idle" || gs.status === "dead") { startRun(); return; }
    if (!jRef.current) { jRef.current = true; recordEvent(0); }
  };
  const onTapEnd = () => {
    if (jRef.current) { jRef.current = false; recordEvent(1); }
  };

  return (
    <div className="space-y-2">
      <div className="relative rounded-2xl overflow-hidden border border-border/50" style={{ lineHeight: 0, boxShadow: "0 20px 60px hsl(220 50% 2% / 0.6)" }}>
        <canvas ref={cvs} width={CW} height={CH}
          style={{ display: "block", width: "100%", height: "auto", touchAction: "none" }}
          onTouchStart={onTapStart}
          onTouchEnd={onTapEnd}
          onTouchCancel={onTapEnd}
        />
        {gs.status === "playing" && (
          <button
            type="button"
            aria-label="Duck"
            onTouchStart={(e) => { e.preventDefault(); if (!dRef.current) { dRef.current = true; recordEvent(2); } }}
            onTouchEnd={(e) => { e.preventDefault(); if (dRef.current) { dRef.current = false; recordEvent(3); } }}
            onTouchCancel={() => { if (dRef.current) { dRef.current = false; recordEvent(3); } }}
            onMouseDown={(e) => { e.preventDefault(); if (!dRef.current) { dRef.current = true; recordEvent(2); } }}
            onMouseUp={() => { if (dRef.current) { dRef.current = false; recordEvent(3); } }}
            onMouseLeave={() => { if (dRef.current) { dRef.current = false; recordEvent(3); } }}
            onContextMenu={(e) => e.preventDefault()}
            className="absolute bottom-3 right-3 select-none px-4 py-2 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent text-xs font-semibold tracking-[0.2em] shadow-[0_0_18px_hsl(var(--accent)/0.25)] active:bg-accent/30 active:scale-95 transition"
            style={{ touchAction: "none" }}
          >
            ↓ DUCK
          </button>
        )}
        {gs.status === "idle" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="text-xs tracking-[0.3em] text-muted-foreground mb-2">READY</div>
            <div className="text-2xl font-semibold text-foreground mb-1">Tap to start running</div>
            <div className="text-xs text-muted-foreground mb-6">SPACE / ↑ jump · ↓ duck · Ƀ +50 pts</div>
            <button
              onClick={startRun}
              className="px-8 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:scale-[1.02] transition-transform shadow-[0_0_30px_hsl(var(--primary)/0.4)]"
            >
              Start run
            </button>
          </div>
        )}
        {gs.status === "dead" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/85 backdrop-blur-sm">
            <div className="text-[10px] tracking-[0.3em] text-destructive/80 mb-2">FORKED</div>
            <div className="num text-4xl sm:text-6xl font-semibold leading-none drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)] text-cyan-100">
              {gs.score.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground mb-6">Block closes in {blockInfo.remaining}s · Replay sealed for verification</div>
            <button
              onClick={startRun}
              className="px-8 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:scale-[1.02] transition-transform shadow-[0_0_30px_hsl(var(--primary)/0.4)]"
            >
              Run again
            </button>
          </div>
        )}
      </div>
      <div className="flex justify-center gap-6 text-[10px] tracking-[0.2em] text-muted-foreground/70 uppercase">
        <span>Space / ↑ Jump</span>
        <span>↓ Duck</span>
        <span>Ƀ +50 pts</span>
      </div>
    </div>
  );
}
