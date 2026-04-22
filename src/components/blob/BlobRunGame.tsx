// @ts-nocheck
import { useEffect, useRef, useState, useCallback } from "react";
import * as Relay from "@/lib/blobRelay";
import { signData } from "@/lib/blob/crypto";
import { CW, CH, GY, PX, GRAVITY, JUMP_V } from "@/lib/blob/constants";
import { generateLevel, TYMAP, drawBG, drawBlob, drawFork, drawToken, _blobImg } from "@/lib/blob/level";

export default function BlobRunGame({ wallet, blockInfo, onEntrySubmit, myEntry }) {
  const cvs = useRef(null);
  const raf = useRef(null);
  const gRef = useRef(null);
  const jRef = useRef(false);
  const dRef = useRef(false);
  const stRef = useRef("idle");
  const [gs, setGs] = useState({ status: "idle", score: 0, combo: 0 });

  const level = useRef(generateLevel(blockInfo.seed));
  const bgNodes = useRef(Array.from({ length: 12 }, () => ({
    x: Math.random() * CW, y: 20 + Math.random() * (GY - 40),
    r: 2 + Math.random() * 9, a: .03 + Math.random() * .09,
    spd: .25 + Math.random() * .8,
  })));

  useEffect(() => {
    level.current = generateLevel(blockInfo.seed);
  }, [blockInfo.seed]);

  useEffect(() => {
    const kd = e => {
      if (e.code === "Space" || e.code === "ArrowUp") { e.preventDefault(); jRef.current = true; }
      if (e.code === "ArrowDown") dRef.current = true;
    };
    const ku = e => {
      if (e.code === "Space" || e.code === "ArrowUp") jRef.current = false;
      if (e.code === "ArrowDown") dRef.current = false;
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, []);

  const startRun = useCallback(async () => {
    cancelAnimationFrame(raf.current);
    jRef.current = false; dRef.current = false;
    stRef.current = "playing";
    let obsIdx = 0, tokIdx = 0;
    const lev = level.current;

    const g: any = {
      frame: 0, score: 0, dist: 0, speed: 4.5, locked: false,
      combo: 0, comboTimer: 0,
      player: { y: GY - 28, vy: 0, action: "run", wob: 0, sq: 1, blink: false },
      obstacles: [], tokens: [], parts: [],
    };
    gRef.current = g;
    setGs({ status: "playing", score: 0, combo: 0 });

    const ctx = cvs.current.getContext("2d");

    function parts(x, y, col, n = 8) {
      for (let i = 0; i < n; i++) g.parts.push({
        x, y, vx: (Math.random() - .5) * 9, vy: Math.random() * -9 - 2,
        life: 1, col, sz: 2 + Math.random() * 4.5,
      });
    }

    function roundedRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function drawHUD() {
      const secs = blockInfo.remaining;
      const m = Math.floor(secs / 60), s = secs % 60;
      const tstr = `${m}:${s.toString().padStart(2, "0")}`;
      const urgent = secs < 20;
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
      ctx.fillText(g.score.toLocaleString(), 26, 42);

      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.fillText(`BLOCK #${blockInfo.height}`, CW / 2, 24);
      ctx.shadowColor = urgent ? "#ff5a6e" : "#7dffe0";
      ctx.shadowBlur = urgent ? 12 : 6;
      ctx.fillStyle = urgent ? "#ff8896" : "#7dffe0";
      ctx.font = `600 18px ${MONO}`;
      ctx.fillText(tstr, CW / 2, 42);
      ctx.shadowBlur = 0;

      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.fillText(`SPEED ×${g.speed.toFixed(1)}`, CW - 26, 24);
      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 14px ${MONO}`;
      ctx.fillText(`${blockInfo.reward} BLOB`, CW - 26, 42);

      if (g.combo > 1) {
        ctx.textAlign = "left";
        ctx.shadowColor = "#ffd166"; ctx.shadowBlur = 14;
        ctx.fillStyle = "#ffd166";
        ctx.font = `700 ${Math.min(13 + g.combo * 2, 26)}px ${FNT}`;
        ctx.fillText(`×${g.combo} combo`, 26, CH - 24);
        ctx.shadowBlur = 0;
      }
      if (g.locked) {
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(7, 12, 22, 0.6)";
        roundedRect(ctx, CW / 2 - 160, CH - 36, 320, 24, 12);
        ctx.fill();
        ctx.fillStyle = "#7dffe0";
        ctx.font = `600 10px ${FNT}`;
        ctx.fillText("✓ Score broadcast — proof in network", CW / 2, CH - 20);
      }
      ctx.restore();
    }

    function draw() {
      const p = g.player;
      bgNodes.current.forEach(n => { n.x -= n.spd; if (n.x < -15) n.x = CW + 15; });
      drawBG(ctx, g.frame, bgNodes.current);
      if (!g.locked && p.action !== "dead" && _blobImg && _blobImg.complete && _blobImg.naturalWidth > 0) {
        if (!g.trail) g.trail = [];
        const tT = p.wob * 0.08;
        const trailFloatY = p.action === "duck" ? 0 : Math.sin(tT) * 5;
        g.trail.unshift({ x: PX, y: p.y + trailFloatY - (p.action === "duck" ? 0 : 4), action: p.action });
        if (g.trail.length > 8) g.trail.length = 8;
        const duck = p.action === "duck";
        const baseW = duck ? 78 : 64;
        const baseH = duck ? 46 : 72;
        for (let i = g.trail.length - 1; i >= 1; i--) {
          const tr = g.trail[i];
          const a = (1 - i / g.trail.length) * 0.28;
          ctx.save();
          ctx.globalAlpha = a;
          ctx.globalCompositeOperation = "lighter";
          ctx.imageSmoothingEnabled = false;
          ctx.translate(tr.x - i * 6, tr.y);
          ctx.scale(1, p.sq);
          ctx.drawImage(_blobImg, -baseW / 2, -baseH / 2, baseW, baseH);
          ctx.restore();
        }
      } else if (g.trail) {
        g.trail.length = 0;
      }
      g.obstacles.forEach(o => drawFork(ctx, o));
      g.tokens.forEach(t => { if (t.alive) drawToken(ctx, t.x, t.y, g.frame); });
      g.parts.forEach(pt => {
        ctx.save(); ctx.globalAlpha = Math.max(0, pt.life);
        ctx.shadowColor = pt.col; ctx.shadowBlur = 10; ctx.fillStyle = pt.col;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.sz, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      });
      if (p.action !== "dead") drawBlob(ctx, PX, p.y, p.action, p.wob, p.sq, p.blink);
      drawHUD();
    }

    async function loop() {
      if (stRef.current !== "playing") return;
      const p = g.player; g.frame++;

      if (p.action !== "dead") {
        if (jRef.current && p.action !== "jump") { p.vy = JUMP_V; p.action = "jump"; }
        if (!jRef.current && dRef.current && p.action !== "jump") p.action = "duck";
        else if (!dRef.current && p.action === "duck") p.action = "run";
        p.vy += GRAVITY; p.y += p.vy;
        const fl = p.action === "duck" ? GY - 16 : GY - 28;
        if (p.y >= fl) {
          if (p.vy > 5) p.sq = 0.5;
          p.y = fl; p.vy = 0;
          if (p.action === "jump") p.action = "run";
        }
        p.sq += (1 - p.sq) * .13; p.wob++; p.blink = (Math.floor(p.wob / 80) % 9 === 0);
        if (!g.locked) {
          g.score++; g.dist += g.speed;
          g.speed = Math.min(4.5 + Math.floor(g.score / 3000) * .5, 12);
        }
        if (g.comboTimer > 0 && --g.comboTimer === 0) g.combo = 0;
      }

      while (obsIdx < lev.obstacles.length && g.dist >= lev.obstacles[obsIdx].at) {
        const ev = lev.obstacles[obsIdx++];
        const ey = ev.type === "tall" ? GY - 90 : GY - 66;
        g.obstacles.push({ x: CW + 8, y: ey, w: ev.w, h: ev.h });
        if (ev.type === "double") g.obstacles.push({ x: CW + 190, y: ey, w: ev.w, h: ev.h });
      }
      while (tokIdx < lev.tokens.length && g.dist >= lev.tokens[tokIdx].at) {
        const ev = lev.tokens[tokIdx++];
        g.tokens.push({ x: CW + 8, y: TYMAP[ev.height], alive: true });
      }
      g.obstacles.forEach(o => o.x -= g.speed);
      g.obstacles = g.obstacles.filter(o => o.x > -70);
      g.tokens.forEach(t => t.x -= g.speed);
      g.tokens = g.tokens.filter(t => t.x > -35);
      g.parts.forEach(pt => { pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028; });
      g.parts = g.parts.filter(pt => pt.life > 0);

      if (p.action !== "dead" && !g.locked) {
        const dk = p.action === "duck";
        const ph = dk ? 22 : 42, pw = dk ? 46 : 30;
        const x1 = PX - pw / 2 + 4, x2 = PX + pw / 2 - 4, y1 = p.y - ph / 2 + 4, y2 = p.y + ph / 2 - 4;
        for (const o of g.obstacles) {
          if (x2 > o.x + 4 && x1 < o.x + o.w - 4 && y2 > o.y + 4 && y1 < o.y + o.h - 4) {
            p.action = "dead"; g.locked = true;
            parts(PX, p.y, "#ff2244", 18); parts(PX, p.y, "#00ffcc", 8);
            stRef.current = "dead";
            const finalScore = g.score;
            const entryData = `${blockInfo.height}:${wallet.address}:${finalScore}`;
            const sig = await signData(wallet.privateKey, entryData);
            const entry = {
              block_height: blockInfo.height,
              block_seed: String(blockInfo.seed),
              address: wallet.address,
              username: wallet.username,
              score: finalScore,
              signature: sig,
              submitted_at: new Date().toISOString(),
            };
            Relay.pushEntry({ ...entry, publicKey: wallet.publicKey });
            onEntrySubmit(entry);
            setGs(prev => ({ ...prev, status: "dead", score: finalScore }));
            draw(); return;
          }
        }
        for (const t of g.tokens) {
          if (t.alive && Math.abs(PX - t.x) < 28 && Math.abs(p.y - t.y) < 28) {
            t.alive = false;
            g.combo = Math.min(g.combo + 1, 10);
            g.comboTimer = 150;
            g.score += Math.floor(50 * (1 + g.combo * .25));
            parts(t.x, t.y, "#00aaff", 8);
          }
        }
      }
      draw();
      setGs(prev => ({ ...prev, score: g.score, combo: g.combo }));
      raf.current = requestAnimationFrame(loop);
    }

    raf.current = requestAnimationFrame(loop);
  }, [blockInfo, wallet, onEntrySubmit, myEntry]);

  useEffect(() => {
    startRun();
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTap = e => {
    e.preventDefault();
    if (gs.status === "idle" || gs.status === "dead") { startRun(); return; }
    jRef.current = true; setTimeout(() => { jRef.current = false; }, 120);
  };

  return (
    <div className="space-y-2">
      <div className="relative rounded-2xl overflow-hidden border border-border/50" style={{ lineHeight: 0, boxShadow: "0 20px 60px hsl(220 50% 2% / 0.6)" }}>
        <canvas ref={cvs} width={CW} height={CH}
          style={{ display: "block", width: "100%", height: "auto" }}
          onTouchStart={onTap} onTouchEnd={() => { jRef.current = false; }}
        />
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
            <div className="num text-5xl font-semibold text-primary mb-1 drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">
              {gs.score.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground mb-6">Block closes in {blockInfo.remaining}s · Score broadcast</div>
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
