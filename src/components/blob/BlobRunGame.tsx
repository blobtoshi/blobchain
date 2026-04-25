// @ts-nocheck
import { useEffect, useRef, useState, useCallback } from "react";
import * as Relay from "@/lib/blobRelay";
import { signData } from "@/lib/blob/crypto";
import { CW, CH, GY, PX } from "@/lib/blob/constants";
import { TYMAP, drawBG, drawBlob, drawFork, drawLowBar, drawToken, _blobImg } from "@/lib/blob/level";
import {
  generateLevelPure, initialState, tick,
  encodeInputs, hashInputs, ENGINE_VERSION,
} from "@/lib/blob/simulator";

export default function BlobRunGame({ wallet, blockInfo, onEntrySubmit, myEntry }) {
  const cvs = useRef(null);
  const raf = useRef(null);
  const stateRef = useRef(null);
  const inputsRef = useRef([]); // recorded events for verifiable replay
  const jRef = useRef(false);
  const dRef = useRef(false);
  const stRef = useRef("idle");
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
    const kd = e => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        if (!jRef.current) { jRef.current = true; recordEvent(0); }
      }
      if (e.code === "ArrowDown") {
        e.preventDefault();
        if (!dRef.current) { dRef.current = true; recordEvent(2); }
      }
    };
    const ku = e => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        if (jRef.current) { jRef.current = false; recordEvent(1); }
      }
      if (e.code === "ArrowDown") {
        e.preventDefault();
        if (dRef.current) { dRef.current = false; recordEvent(3); }
      }
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [recordEvent]);

  const startRun = useCallback(async () => {
    cancelAnimationFrame(raf.current);
    jRef.current = false; dRef.current = false;
    stRef.current = "playing";
    inputsRef.current = [];
    const lev = level.current;
    const state = initialState();
    stateRef.current = state;
    setGs({ status: "playing", score: 0, combo: 0 });

    const ctx = cvs.current.getContext("2d");
    const parts = []; // visual-only, NOT part of consensus

    function spawnParts(x, y, col, n = 8) {
      for (let i = 0; i < n; i++) parts.push({
        x, y, vx: (Math.random() - .5) * 9, vy: Math.random() * -9 - 2,
        life: 1, col, sz: 2 + Math.random() * 4.5,
      });
    }

    function roundedRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function drawHUD() {
      const FNT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif';
      const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
      ctx.save();
      ctx.fillStyle = "rgba(7, 12, 22, 0.55)";
      roundedRect(ctx, 12, 10, CW - 24, 38, 12);
      ctx.fill();
      ctx.strokeStyle = "rgba(125, 255, 224, 0.10)";
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.textAlign = "left";
      ctx.fillText("SCORE", 26, 24);
      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 18px ${MONO}`;
      ctx.fillText(state.score.toLocaleString(), 26, 42);

      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.fillText(`BLOCK #${blockInfo.height}`, CW / 2, 24);
      ctx.fillStyle = "#7dffe0";
      ctx.font = `600 18px ${MONO}`;
      ctx.fillText(`#${blockInfo.height}`, CW / 2, 42);

      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.fillText(`SPEED ×${state.speed.toFixed(1)}`, CW - 26, 24);
      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 14px ${MONO}`;
      ctx.fillText(`${blockInfo.reward} BLOB`, CW - 26, 42);

      if (state.combo > 1) {
        ctx.textAlign = "left";
        ctx.shadowColor = "#ffd166"; ctx.shadowBlur = 14;
        ctx.fillStyle = "#ffd166";
        ctx.font = `700 ${Math.min(13 + state.combo * 2, 26)}px ${FNT}`;
        ctx.fillText(`×${state.combo} combo`, 26, CH - 24);
        ctx.shadowBlur = 0;
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
      ctx.restore();
    }

    function draw() {
      const p = state.player;
      bgNodes.current.forEach(n => { n.x -= n.spd; if (n.x < -15) n.x = CW + 15; });
      drawBG(ctx, state.frame, bgNodes.current);
      if (!state.locked && p.action !== "dead" && _blobImg && _blobImg.complete && _blobImg.naturalWidth > 0) {
        if (!state._trail) state._trail = [];
        const tT = p.wob * 0.08;
        const trailFloatY = p.action === "duck" ? 0 : Math.sin(tT) * 5;
        state._trail.unshift({ x: PX, y: p.y + trailFloatY - (p.action === "duck" ? 0 : 4), action: p.action });
        if (state._trail.length > 8) state._trail.length = 8;
        const duck = p.action === "duck";
        const baseW = duck ? 78 : 64;
        const baseH = duck ? 46 : 72;
        for (let i = state._trail.length - 1; i >= 1; i--) {
          const tr = state._trail[i];
          const a = (1 - i / state._trail.length) * 0.28;
          ctx.save();
          ctx.globalAlpha = a;
          ctx.globalCompositeOperation = "lighter";
          ctx.imageSmoothingEnabled = false;
          ctx.translate(tr.x - i * 6, tr.y);
          ctx.scale(1, p.sq);
          ctx.drawImage(_blobImg, -baseW / 2, -baseH / 2, baseW, baseH);
          ctx.restore();
        }
      } else if (state._trail) {
        state._trail.length = 0;
      }
      state.obstacles.forEach(o => o.type === "low" ? drawLowBar(ctx, o) : drawFork(ctx, o));
      state.tokens.forEach(t => { if (t.alive) drawToken(ctx, t.x, t.y, state.frame); });
      parts.forEach(pt => {
        ctx.save(); ctx.globalAlpha = Math.max(0, pt.life);
        ctx.shadowColor = pt.col; ctx.shadowBlur = 10; ctx.fillStyle = pt.col;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.sz, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
      if (!state.dead) drawBlob(ctx, PX, p.y, p.action, p.wob, p.sq, false);
      drawHUD();
    }

    async function loop() {
      if (stRef.current !== "playing") return;
      // Collect events queued for the upcoming tick (recordEvent appends with
      // f = state.frame + 1, so they live at the tail of inputsRef).
      const targetFrame = state.frame + 1;
      const queuedAtFrame: any[] = [];
      for (let i = inputsRef.current.length - 1; i >= 0 && inputsRef.current[i].f === targetFrame; i--) {
        queuedAtFrame.unshift(inputsRef.current[i]);
      }

      const prevTokensAlive = state.tokens.filter(t => t.alive).length;
      const alive = tick(state, lev, queuedAtFrame);

      // Visual-only effects driven from state diffs
      const newTokensAlive = state.tokens.filter(t => t.alive).length;
      // (token pickup particles fire when alive count drops mid-frame from collision)
      if (newTokensAlive < prevTokensAlive) {
        // Find the picked-up token roughly at PX
        spawnParts(PX, state.player.y, "#00aaff", 8);
      }

      if (!alive) {
        spawnParts(PX, state.player.y, "#ff2244", 18);
        spawnParts(PX, state.player.y, "#00ffcc", 8);
        stRef.current = "dead";
        const finalScore = state.score;
        const frameCount = state.frame;
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
        setGs(prev => ({ ...prev, status: "dead", score: finalScore }));
        // Update particles one last time for the fade-out frame
        parts.forEach(pt => { pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028; });
        for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);
        draw();
        return;
      }

      parts.forEach(pt => { pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028; });
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i].life <= 0) parts.splice(i, 1);

      draw();
      if (state.combo !== state._lastCombo) {
        state._lastCombo = state.combo;
        setGs(prev => ({ ...prev, score: state.score, combo: state.combo }));
      }
      raf.current = requestAnimationFrame(loop);
    }

    raf.current = requestAnimationFrame(loop);
  }, [blockInfo, wallet, onEntrySubmit]);

  useEffect(() => {
    startRun();
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTap = e => {
    e.preventDefault();
    if (gs.status === "idle" || gs.status === "dead") { startRun(); return; }
    if (!jRef.current) { jRef.current = true; recordEvent(0); }
    setTimeout(() => {
      if (jRef.current) { jRef.current = false; recordEvent(1); }
    }, 120);
  };

  return (
    <div className="space-y-2">
      <div className="relative rounded-2xl overflow-hidden border border-border/50" style={{ lineHeight: 0, boxShadow: "0 20px 60px hsl(220 50% 2% / 0.6)" }}>
        <canvas ref={cvs} width={CW} height={CH}
          style={{ display: "block", width: "100%", height: "auto", touchAction: "none" }}
          onTouchStart={onTap} onTouchEnd={() => {
            if (jRef.current) { jRef.current = false; recordEvent(1); }
          }}
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
            <div className="num text-4xl sm:text-6xl font-semibold leading-none drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)] text-teal-100">
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
