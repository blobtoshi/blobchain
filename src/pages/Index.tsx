// @ts-nocheck
// ═══════════════════════════════════════════════════════════════════════════════
// ⬡ BLOB CHAIN — Proof-of-Gaming Blockchain (single-node local build)
// Bitcoin clone: $BLOB token, 0 starting supply, gameplay-mined
// Real ECDSA wallet · SHA-256 block hashing · Weighted lottery consensus
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from "react";
import * as Relay from "@/lib/blobRelay";

// 1. CONFIG ────────────────────────────────────────────────────────────────────
const BLOCK_TIME = 120;
const INITIAL_REWARD = 50;
const HALVING_BLOCKS = 210000;
const MAX_SUPPLY = 21000000;
const TX_FEE = 0.001;
const GENESIS_TIME_MS = 1745000000000;

const SB_URL: string | undefined = (import.meta as any)?.env?.VITE_SUPABASE_URL;
const SB_KEY: string | undefined = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY;

const CW = 780, CH = 360, GY = 290, PX = 130;
const GRAVITY = 0.66, JUMP_V = -14.5;

// 2. CRYPTO UTILITIES ─────────────────────────────────────────────────────────
const enc = new TextEncoder();

async function sha256hex(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function generateWallet() {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pubStr = JSON.stringify(pub);
  const privStr = JSON.stringify(priv);
  const addrHash = await sha256hex(pubStr);
  const address = "0x" + addrHash.slice(0, 40);
  return { address, publicKey: pubStr, privateKey: privStr };
}

async function signData(privKeyStr, data) {
  try {
    const key = await crypto.subtle.importKey(
      "jwk", JSON.parse(privKeyStr),
      { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data)
    );
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  } catch { return ""; }
}

// Mulberry32 PRNG
function mkPrng(seed) {
  let s = (Math.abs(+seed) * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 3. BLOCK TIMING ──────────────────────────────────────────────────────────────
function getRewardForHeight(height) {
  const halvings = Math.floor(height / HALVING_BLOCKS);
  return Math.min(INITIAL_REWARD / Math.pow(2, halvings), INITIAL_REWARD);
}

function getBlockInfo() {
  const now = Math.floor(Date.now() / 1000);
  const genesis = Math.floor(GENESIS_TIME_MS / 1000);
  const sinceGenesis = Math.max(0, now - genesis);
  const height = Math.floor(sinceGenesis / BLOCK_TIME) + 1;
  const elapsed = sinceGenesis % BLOCK_TIME;
  const remaining = BLOCK_TIME - elapsed;
  const reward = getRewardForHeight(height);
  const seed = height * 6364136223846793 + 1442695040888963407;
  return { height, elapsed, remaining, reward, seed: Math.abs(seed % 2147483647) };
}

// 4. BLOCKCHAIN CORE ───────────────────────────────────────────────────────────
const GENESIS = {
  height: 0,
  previousHash: "0".repeat(64),
  timestamp: GENESIS_TIME_MS,
  transactions: [],
  miningEntries: [],
  winner: null,
  winnerScore: 0,
  winnerUsername: "Satoshi Blobamoto",
  reward: 0,
  seed: "genesis",
  hash: "genesis00000000000000000000000000000000000000000000000000000000blob",
  totalSupply: 0,
  nodeCount: 0,
};

async function computeBlockHash(b) {
  const header = [
    b.height, b.previousHash, b.timestamp,
    b.winner || "null", b.winnerScore, b.reward, b.seed,
    b.transactions.length,
  ].join("|");
  return sha256hex(header);
}

function calcBalance(address, chain) {
  let bal = 0;
  for (const block of chain) {
    if (block.winner === address) bal += (block.reward || 0);
    for (const tx of (block.transactions || [])) {
      if (tx.to === address) bal += tx.amount;
      if (tx.from === address) bal -= (tx.amount + (tx.fee || TX_FEE));
    }
  }
  return +Math.max(0, bal).toFixed(6);
}

function calcTotalSupply(chain) {
  return chain.reduce((s, b) => s + (b.reward || 0), 0);
}

function pickWinner(entries, blockSeed) {
  if (!entries || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.address < b.address ? -1 : 1);
  const total = sorted.reduce((s, e) => s + e.score, 0);
  if (total === 0) return sorted[0];
  const rng = mkPrng(blockSeed);
  let target = rng() * total;
  for (const e of sorted) {
    target -= e.score;
    if (target <= 0) return e;
  }
  return sorted[sorted.length - 1];
}

function winProbability(score, allEntries) {
  const total = allEntries.reduce((s, e) => s + e.score, 0);
  if (total === 0) return 0;
  return +((score / total) * 100).toFixed(1);
}

// 5. SEEDED LEVEL GENERATOR ───────────────────────────────────────────────────
function generateLevel(seed) {
  const rng = mkPrng(seed);
  const obstacles = [], tokens = [];
  let pos = 250;
  while (pos < 150000) {
    const gap = 240 + rng() * 280;
    pos += gap;
    const r = rng();
    if (r < 0.5) obstacles.push({ at: pos, type: "fork", w: 36, h: 66 });
    else if (r < 0.78) obstacles.push({ at: pos, type: "double", w: 36, h: 66 });
    else obstacles.push({ at: pos, type: "tall", w: 40, h: 90 });
    if (rng() < 0.68) {
      const hs = ["low", "mid", "high"];
      tokens.push({ at: pos - gap * 0.4, height: hs[Math.floor(rng() * 3)] });
    }
  }
  return { obstacles, tokens };
}
const TYMAP = { low: GY - 52, mid: GY - 94, high: GY - 140 };

// 6. P2P LAYER — backed by Lovable Cloud (see src/lib/blobRelay.ts) ───────────

// 7. CANVAS DRAW HELPERS ───────────────────────────────────────────────────────
function drawBG(ctx, frame, nodes) {
  ctx.fillStyle = "#05070f";
  ctx.fillRect(0, 0, CW, CH);
  for (let i = 0; i < 8; i++) {
    const t = i / 8;
    const x = ((CW * t + frame * (1.2 + t * 3.5)) % CW);
    ctx.strokeStyle = `rgba(0,255,180,${0.02 + t * 0.035})`;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, GY); ctx.lineTo(x - 90, CH); ctx.stroke();
  }
  nodes.forEach(n => {
    ctx.save(); ctx.globalAlpha = n.a;
    ctx.strokeStyle = "#00ffcc"; ctx.lineWidth = .8;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  });
  const g = ctx.createLinearGradient(0, GY, 0, CH);
  g.addColorStop(0, "#091a30"); g.addColorStop(1, "#030810");
  ctx.fillStyle = g; ctx.fillRect(0, GY, CW, CH - GY);
  ctx.save(); ctx.shadowColor = "#00ffcc"; ctx.shadowBlur = 10;
  ctx.strokeStyle = "#00ffcc"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, GY); ctx.lineTo(CW, GY); ctx.stroke();
  ctx.restore();
}

function drawBlob(ctx, x, y, action, wob, sq, blink) {
  const duck = action === "duck";
  const rx = duck ? 32 : 20, ry = duck ? 15 : 26;
  const wb = Math.sin(wob * .12) * (duck ? 1.5 : 2.5);
  ctx.save(); ctx.translate(x, y); ctx.scale(1, sq);
  ctx.shadowColor = "#00ffcc"; ctx.shadowBlur = 20;
  ctx.beginPath(); ctx.fillStyle = "#00ffcc";
  ctx.moveTo(0, -ry);
  ctx.bezierCurveTo(rx + wb, -ry * .7, rx + wb, ry * .7, 0, ry);
  ctx.bezierCurveTo(-rx - wb, ry * .7, -rx - wb, -ry * .7, 0, -ry);
  ctx.fill();
  ctx.shadowBlur = 0; ctx.fillStyle = "rgba(160,255,230,.18)";
  ctx.beginPath(); ctx.ellipse(-5, -7, rx * .36, ry * .3, -.3, 0, Math.PI * 2); ctx.fill();
  if (!duck) {
    if (!blink) {
      ctx.fillStyle = "#001510";
      ctx.beginPath(); ctx.ellipse(-8, -8, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(8, -8, 4.5, 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(-6.5, -10, 2, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(9.5, -10, 2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.strokeStyle = "#001510"; ctx.lineWidth = 2.2; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-12, -8); ctx.lineTo(-4, -8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(4, -8); ctx.lineTo(12, -8); ctx.stroke();
    }
    const sw = Math.sin(wob * .24) * 10;
    ctx.shadowBlur = 0; ctx.fillStyle = "#009966";
    ctx.beginPath(); ctx.ellipse(-7, ry - 3, 5, 8, sw * .07, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(7, ry - 3, 5, 8, -sw * .07, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = "#001510";
    ctx.beginPath(); ctx.ellipse(-8, 0, 4.5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8, 0, 4.5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawFork(ctx, o) {
  const cx = o.x + o.w / 2;
  ctx.save(); ctx.shadowColor = "#ff2244"; ctx.shadowBlur = 16;
  ctx.fillStyle = "#bb1133";
  ctx.fillRect(cx - 4, o.y + o.h * .46, 8, o.h * .54);
  ctx.beginPath();
  ctx.moveTo(cx, o.y + o.h * .49);
  ctx.lineTo(o.x + 3, o.y + 7); ctx.lineTo(o.x + 13, o.y + 7);
  ctx.lineTo(cx, o.y + o.h * .27);
  ctx.lineTo(o.x + o.w - 13, o.y + 7); ctx.lineTo(o.x + o.w - 3, o.y + 7);
  ctx.closePath(); ctx.fillStyle = "#ff2244"; ctx.fill();
  ctx.shadowBlur = 0; ctx.fillStyle = "#ff5566";
  ctx.font = "bold 7px monospace"; ctx.textAlign = "center";
  ctx.fillText("FORK", cx, o.y - 4);
  ctx.restore();
}

function drawToken(ctx, tx, ty, frame) {
  const p = Math.sin(frame * .08 + tx * .009) * 2.5;
  ctx.save(); ctx.translate(tx, ty + p);
  ctx.shadowColor = "#00aaff"; ctx.shadowBlur = 20;
  ctx.strokeStyle = "#00aaff"; ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(0, 0, 13, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "rgba(0,170,255,.1)"; ctx.fill();
  ctx.fillStyle = "#00aaff"; ctx.font = "bold 11px monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.shadowBlur = 6; ctx.fillText("Ƀ", 0, 1);
  ctx.restore();
}

// 8. BLOB RUN GAME COMPONENT ──────────────────────────────────────────────────
function BlobRunGame({ wallet, blockInfo, onEntrySubmit, myEntry }) {
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

    function drawHUD() {
      const secs = blockInfo.remaining;
      const m = Math.floor(secs / 60), s = secs % 60;
      const tstr = `${m}:${s.toString().padStart(2, "0")}`;
      const urgent = secs < 20;
      ctx.save();
      ctx.shadowColor = "#00ffcc"; ctx.shadowBlur = 10;
      ctx.fillStyle = "#00ffcc"; ctx.font = 'bold 22px "Courier New",monospace';
      ctx.textAlign = "left"; ctx.fillText(g.score.toLocaleString(), 16, 36);
      ctx.shadowBlur = 0; ctx.fillStyle = "#0e2830";
      ctx.font = '8px "Courier New",monospace'; ctx.fillText("SCORE", 16, 48);
      ctx.textAlign = "center";
      ctx.shadowColor = urgent ? "#ff3322" : "#00ffcc"; ctx.shadowBlur = urgent ? 20 : 6;
      ctx.fillStyle = urgent ? "#ff3322" : "#00ffcc";
      ctx.font = 'bold 18px "Courier New",monospace'; ctx.fillText(tstr, CW / 2, 34);
      ctx.shadowBlur = 0; ctx.fillStyle = "#0e2830";
      ctx.font = '8px "Courier New",monospace'; ctx.fillText("BLOCK " + blockInfo.height, CW / 2, 47);
      ctx.textAlign = "right"; ctx.fillStyle = "#0e2830";
      ctx.font = '9px "Courier New",monospace';
      ctx.fillText(`⬡ ${blockInfo.reward} $BLOB REWARD`, CW - 14, 36);
      ctx.fillStyle = "#0a2030"; ctx.font = '8px "Courier New",monospace';
      ctx.fillText(`SPD ×${g.speed.toFixed(1)}`, CW - 14, 48);
      if (g.combo > 1) {
        ctx.textAlign = "left"; ctx.shadowColor = "#ffcc00"; ctx.shadowBlur = 14;
        ctx.fillStyle = "#ffcc00";
        ctx.font = `bold ${Math.min(11 + g.combo * 2, 26)}px "Courier New",monospace`;
        ctx.fillText(`×${g.combo} COMBO!`, 16, CH - 20);
      }
      if (g.locked) {
        ctx.textAlign = "center"; ctx.shadowColor = "#ff3355"; ctx.shadowBlur = 8;
        ctx.fillStyle = "#ff3355"; ctx.font = 'bold 10px "Courier New",monospace';
        ctx.fillText("⚠ SCORE SUBMITTED · PROOF IN NETWORK", CW / 2, CH - 14);
      }
      ctx.restore();
    }

    function draw() {
      const p = g.player;
      bgNodes.current.forEach(n => { n.x -= n.spd; if (n.x < -15) n.x = CW + 15; });
      drawBG(ctx, g.frame, bgNodes.current);
      if (!g.locked && p.action !== "dead") {
        for (let i = 1; i <= 3; i++) {
          ctx.save(); ctx.globalAlpha = .05 * (4 - i); ctx.fillStyle = "#00ffcc";
          ctx.beginPath(); ctx.ellipse(PX - i * 10, p.y, 18, 24, 0, 0, Math.PI * 2);
          ctx.fill(); ctx.restore();
        }
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
            Relay.pushEntry(entry);
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

  const onTap = e => {
    e.preventDefault();
    if (gs.status === "idle" || gs.status === "dead") { startRun(); return; }
    jRef.current = true; setTimeout(() => { jRef.current = false; }, 120);
  };

  const F = '"Courier New",monospace';
  const Ov = ({ ch }) => (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "rgba(5,7,15,.92)", fontFamily: F }}>
      {ch}
    </div>
  );
  const Btn = ({ onClick, children, col = "#00ffcc" }) => (
    <button onClick={onClick} style={{ background: "transparent", border: `2px solid ${col}`, color: col, padding: "11px 44px", fontSize: 13, fontFamily: F, letterSpacing: 4, cursor: "pointer", fontWeight: "bold" }}
      onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = col + "22"}
      onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = "transparent"}
    >{children}</button>
  );

  return (
    <div>
      <div style={{ position: "relative", lineHeight: 0, borderRadius: 2, overflow: "hidden" }}>
        <canvas ref={cvs} width={CW} height={CH}
          style={{ display: "block", maxWidth: "100%", boxShadow: "0 0 60px #00ffcc0a" }}
          onTouchStart={onTap} onTouchEnd={() => { jRef.current = false; }}
        />
        {gs.status === "idle" && (
          <Ov ch={<>
            <div style={{ fontSize: 46, marginBottom: 8 }}>⬡</div>
            <div style={{ color: "#00ffcc", fontSize: 22, letterSpacing: 6, fontWeight: "bold", marginBottom: 6, textShadow: "0 0 20px #00ffcc" }}>
              MINE $BLOB
            </div>
            <div style={{ color: "#2a4455", fontSize: 11, marginBottom: 6, textAlign: "center", lineHeight: 1.9 }}>
              Block #{blockInfo.height} · Reward: {blockInfo.reward} $BLOB<br />
              {blockInfo.remaining}s remaining · Level seed #{blockInfo.seed}
            </div>
            <div style={{ color: "#0e2030", fontSize: 10, marginBottom: 30, textAlign: "center", lineHeight: 2 }}>
              SPACE/↑ JUMP · ↓ DUCK · Ƀ +50 PTS<br />
              Higher score = higher probability of winning block reward
            </div>
            <Btn onClick={startRun}>START MINING</Btn>
          </>} />
        )}
        {gs.status === "dead" && (
          <Ov ch={<>
            <div style={{ color: "#ff2244", fontSize: 26, fontWeight: "bold", letterSpacing: 5, textShadow: "0 0 24px #ff2244", marginBottom: 4 }}>FORKED</div>
            <div style={{ color: "#1a3040", fontSize: 10, letterSpacing: 3, marginBottom: 18 }}>PROOF BROADCAST TO ALL NODES</div>
            <div style={{ color: "#00ffcc", fontSize: 54, fontWeight: "bold", textShadow: "0 0 36px #00ffcc66", marginBottom: 4 }}>
              {gs.score.toLocaleString()}
            </div>
            <div style={{ color: "#1a3040", fontSize: 10, marginBottom: 28, textAlign: "center" }}>
              Block closes in {blockInfo.remaining}s · Weighted lottery determines winner
            </div>
            <Btn onClick={startRun} col="#ff2244">NEXT BLOCK</Btn>
          </>} />
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: 28, marginTop: 8, color: "#1a3040", fontSize: 9, letterSpacing: 2, fontFamily: F }}>
        <span>SPACE/↑ JUMP</span><span>↓ DUCK</span><span>Ƀ +50 PTS</span><span>SURVIVE TO MINE</span>
      </div>
    </div>
  );
}

// 9. SEND TX FORM ──────────────────────────────────────────────────────────────
function SendTx({ wallet, chain, onBroadcast }) {
  const [to, setTo] = useState(""); const [amt, setAmt] = useState("");
  const [st, setSt] = useState("idle"); const [err, setErr] = useState("");
  const balance = calcBalance(wallet.address, chain);
  const F = '"Courier New",monospace';
  const inp: any = { width: "100%", padding: "10px 14px", background: "transparent", border: "1px solid #0a2030", color: "#00ffcc", fontFamily: F, fontSize: 12, letterSpacing: 1, marginBottom: 10, outline: "none", boxSizing: "border-box" };

  async function send() {
    setErr(""); const amount = parseFloat(amt);
    if (!to.startsWith("0x") || to.length < 10) { setErr("Invalid address"); return; }
    if (!amount || amount <= 0) { setErr("Invalid amount"); return; }
    if (amount + TX_FEE > balance) { setErr(`Insufficient balance (need ${(amount + TX_FEE).toFixed(6)})`); return; }
    setSt("signing");
    try {
      const txid = await sha256hex(`${wallet.address}${to}${amount}${Date.now()}`);
      const data = `${wallet.address}→${to}:${amount}@${Date.now()}`;
      const sig = await signData(wallet.privateKey, data);
      const tx = {
        id: `0x${txid.slice(0, 40)}`,
        from: wallet.address, fromUsername: wallet.username,
        to, amount, fee: TX_FEE,
        signature: sig, publicKey: wallet.publicKey,
        timestamp: Date.now(),
        status: "pending",
      };
      setSt("broadcasting");
      await Relay.pushTx(tx);
      onBroadcast(tx);
      setSt("sent"); setTo(""); setAmt("");
      setTimeout(() => setSt("idle"), 3000);
    } catch (e) { setErr(String(e)); setSt("idle"); }
  }

  return (
    <div style={{ fontFamily: F }}>
      <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 3, marginBottom: 14 }}>SEND $BLOB</div>
      <div style={{ color: "#1a3040", fontSize: 10, marginBottom: 14 }}>
        Balance: <span style={{ color: "#00ffcc" }}>{balance.toFixed(6)} $BLOB</span> · Fee: {TX_FEE} $BLOB
      </div>
      <input value={to} onChange={e => setTo(e.target.value)} placeholder="Recipient address (0x...)" style={inp} />
      <input value={amt} onChange={e => setAmt(e.target.value)} placeholder="Amount" type="number" min="0" style={inp} />
      {err && <div style={{ color: "#ff4455", fontSize: 10, marginBottom: 10 }}>{err}</div>}
      {st === "sent" && <div style={{ color: "#00ffcc", fontSize: 10, marginBottom: 10 }}>✓ Broadcast to network · Pending mempool</div>}
      <button onClick={send} disabled={st !== "idle"} style={{
        padding: "10px 32px", background: "transparent", border: "2px solid #00ffcc44",
        color: st === "idle" ? "#00ffcc" : "#1a4455", fontFamily: F, fontSize: 12,
        letterSpacing: 3, cursor: st === "idle" ? "pointer" : "default",
      }}>
        {st === "idle" ? "BROADCAST TX" : st === "signing" ? "SIGNING…" : st === "broadcasting" ? "BROADCASTING…" : "✓ SENT"}
      </button>
    </div>
  );
}

// 10. MINING PANEL ─────────────────────────────────────────────────────────────
function MiningPanel({ blockInfo, entries, myEntry, chain }) {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const total = entries.reduce((s, e) => s + e.score, 0);
  const supplyNow = calcTotalSupply(chain);
  const F = '"Courier New",monospace';
  const Bar = ({ pct, col }) => (
    <div style={{ flex: 1, height: 3, background: "#0a1a28", borderRadius: 1 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: col, borderRadius: 1, transition: "width .6s" }} />
    </div>
  );
  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 1, marginBottom: 14 }}>
        {[
          ["#" + blockInfo.height, "BLOCK", "#00ffcc"],
          [blockInfo.reward + " $BLOB", "REWARD", "#ffcc00"],
          [blockInfo.remaining + "s", "REMAINING", "#3a86ff"],
          [entries.length, "MINERS", "#ff6b6b"],
        ].map(([v, l, c]: any) => (
          <div key={l} style={{ padding: "12px 14px", background: "#060a14", border: "1px solid #0a1828" }}>
            <div style={{ color: c, fontSize: 18, fontWeight: "bold", fontFamily: F }}>{v}</div>
            <div style={{ color: "#0e2030", fontSize: 8, marginTop: 3, letterSpacing: 2 }}>{l}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "10px 14px", border: "1px solid #0a1828", marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ color: "#0e2030", fontSize: 9, letterSpacing: 2 }}>$BLOB SUPPLY</span>
          <span style={{ color: "#2a5544", fontSize: 9 }}>{supplyNow.toFixed(2)} / {MAX_SUPPLY.toLocaleString()}</span>
        </div>
        <Bar pct={(supplyNow / MAX_SUPPLY) * 100} col="#00ffcc" />
      </div>

      <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>CURRENT BLOCK ENTRIES</div>
      {entries.length === 0 && (
        <div style={{ color: "#0a1e2a", fontSize: 11, padding: "20px 0", textAlign: "center" }}>
          No entries yet this block — play Blob Run to submit yours
        </div>
      )}
      {sorted.map((e, i) => {
        const pct = total > 0 ? +((e.score / total) * 100).toFixed(1) : 0;
        const isMe = e.address === myEntry?.address;
        return (
          <div key={e.address + i} style={{ padding: "10px 14px", marginBottom: 2, background: isMe ? "rgba(0,255,204,.04)" : "#060a14", border: isMe ? "1px solid #00ffcc22" : "1px solid #0a1828" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: i === 0 ? "#ffcc00" : "#1a3040", fontSize: i < 3 ? 14 : 11, width: 24 }}>
                {i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`}
              </span>
              <span style={{ flex: 1, color: isMe ? "#00ffcc" : "#3a5566", fontSize: 11 }}>{e.username || e.address?.slice(0, 14)}</span>
              <span style={{ color: "#4a7060", fontSize: 11, fontWeight: "bold" }}>{e.score.toLocaleString()}</span>
              <span style={{ color: pct > 20 ? "#ffcc00" : pct > 5 ? "#3a8855" : "#1a3040", fontSize: 10, width: 50, textAlign: "right" }}>{pct}%</span>
              <div style={{ width: 80 }}>
                <Bar pct={Math.min(pct, 100)} col={isMe ? "#00ffcc" : i === 0 ? "#ffcc00" : "#2a5566"} />
              </div>
            </div>
          </div>
        );
      })}
      {myEntry && (
        <div style={{ marginTop: 10, color: "#0e2030", fontSize: 9, textAlign: "center", letterSpacing: 1 }}>
          Your win probability: <span style={{ color: "#00ffcc" }}>{winProbability(myEntry.score, entries)}%</span> · Lottery is weighted random — anyone can win
        </div>
      )}
    </div>
  );
}

// 11. BLOCK EXPLORER ──────────────────────────────────────────────────────────
function BlockExplorer({ chain, blockInfo }) {
  const [sel, setSel] = useState(null);
  const F = '"Courier New",monospace';
  const display = [...chain].reverse().slice(0, 30);
  const grid = "60px 1fr 90px 90px 60px";
  return (
    <div style={{ fontFamily: F }}>
      <div style={{ padding: "10px 16px", border: "1px solid #00ffcc11", marginBottom: 14 }}>
        <span style={{ color: "#2a5544", fontSize: 10 }}>⬡ BLOB CHAIN</span>
        <span style={{ color: "#0e2030", fontSize: 9, marginLeft: 16 }}>{chain.length} blocks</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 10, padding: "8px 14px" }}>
        {["HEIGHT", "WINNER", "SCORE", "REWARD", "TXS"].map(h => (
          <div key={h} style={{ color: "#0a1e2a", fontSize: 8, letterSpacing: 2 }}>{h}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: grid, gap: 10, padding: "10px 14px", background: "#060a14", border: "1px solid #ffcc0011", marginBottom: 2 }}>
        <div style={{ color: "#ffcc00", fontSize: 11 }}>#{blockInfo.height}</div>
        <div style={{ color: "#1a3040", fontSize: 11 }}>🕒 mining...</div>
        <div style={{ color: "#1a3040", fontSize: 11 }}>—</div>
        <div style={{ color: "#ffcc00", fontSize: 11 }}>{blockInfo.reward} $BLOB</div>
        <div style={{ color: "#1a3040", fontSize: 11 }}>—</div>
      </div>
      {display.map(b => (
        <div key={b.height}>
          <div onClick={() => setSel(sel === b.height ? null : b.height)}
            style={{ display: "grid", gridTemplateColumns: grid, gap: 10, padding: "10px 14px", cursor: "pointer", borderBottom: "1px solid #07101a" }}>
            <div style={{ color: "#1a3040", fontSize: 11 }}>#{b.height}</div>
            <div style={{ color: "#5a8090", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.winnerUsername || b.winner?.slice(0, 18) || "—"}
            </div>
            <div style={{ color: "#2a5040", fontSize: 11 }}>{b.winnerScore > 0 ? b.winnerScore : "—"}</div>
            <div style={{ color: "#3a6050", fontSize: 11 }}>{b.reward > 0 ? `${b.reward} ⬡` : "—"}</div>
            <div style={{ color: "#1a3040", fontSize: 11 }}>{(b.transactions || []).length}</div>
          </div>
          {sel === b.height && (
            <div style={{ padding: "12px 20px", background: "#060a14", border: "1px solid #0a1828", marginBottom: 2, fontSize: 9, color: "#2a5060", lineHeight: 2.4, overflowX: "auto" }}>
              <div><span style={{ color: "#0e2030" }}>HASH: </span>{b.hash}</div>
              <div><span style={{ color: "#0e2030" }}>PREV: </span>{b.previousHash?.slice(0, 40)}…</div>
              <div><span style={{ color: "#0e2030" }}>SEED: </span>{b.seed}</div>
              <div><span style={{ color: "#0e2030" }}>TIME: </span>{new Date(b.timestamp).toLocaleString()}</div>
              <div><span style={{ color: "#0e2030" }}>WINNER: </span>{b.winner || "—"}</div>
              {(b.transactions || []).map((tx, i) => (
                <div key={i} style={{ color: "#1a3040" }}>TX: {tx.fromUsername || tx.from?.slice(0, 10)} → {tx.to?.slice(0, 10)} · {tx.amount} $BLOB</div>
              ))}
            </div>
          )}
        </div>
      ))}
      {chain.length <= 1 && (
        <div style={{ color: "#0a1e2a", textAlign: "center", padding: "30px 0", fontSize: 11 }}>
          Chain starts at genesis · Mine the first block to begin
        </div>
      )}
    </div>
  );
}

// 12. MEMPOOL VIEW ─────────────────────────────────────────────────────────────
function Mempool({ mempool, wallet }) {
  const F = '"Courier New",monospace';
  return (
    <div style={{ fontFamily: F }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 2 }}>PENDING TRANSACTIONS</div>
        <div style={{ color: "#1a3040", fontSize: 9 }}>{mempool.length} unconfirmed</div>
      </div>
      {mempool.length === 0 && (
        <div style={{ color: "#0a1e2a", textAlign: "center", padding: "30px 0", fontSize: 11 }}>
          No pending transactions · Mempool empty
        </div>
      )}
      {mempool.map((tx, i) => {
        const isMe = tx.from === wallet.address;
        return (
          <div key={tx.id || i} style={{ padding: "10px 16px", marginBottom: 3, background: isMe ? "rgba(0,255,204,.03)" : "rgba(255,255,255,.015)", border: isMe ? "1px solid #00ffcc1a" : "1px solid transparent", borderLeft: "3px solid #0a2030" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ color: "#2a5060", fontSize: 11 }}>{tx.fromUsername || tx.from?.slice(0, 16) + "…"}</span>
              <span style={{ color: "#3a6050", fontSize: 11, fontWeight: "bold" }}>{tx.amount} $BLOB</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#0a1e2a", fontSize: 9 }}>fee: {tx.fee || TX_FEE} $BLOB</span>
              <span style={{ color: "#0a1e2a", fontSize: 9 }}>{new Date(tx.timestamp).toLocaleTimeString()}</span>
              <span style={{ color: "#0f3020", fontSize: 9 }}>⧗ pending</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// 13. WALLET SCREEN ────────────────────────────────────────────────────────────
function WalletScreen({ wallet, chain, mempool }) {
  const [showPriv, setShowPriv] = useState(false);
  const [copied, setCopied] = useState(false);
  const balance = calcBalance(wallet.address, chain);
  const pending = mempool.filter(tx => tx.to === wallet.address).reduce((s, tx) => s + tx.amount, 0);
  const totalBlocks = chain.filter(b => b.winner === wallet.address).length;
  const totalMined = chain.filter(b => b.winner === wallet.address).reduce((s, b) => s + (b.reward || 0), 0);
  const F = '"Courier New",monospace';
  const copy = async () => {
    try { await navigator.clipboard.writeText(wallet.address); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };
  const Stat = ({ label, val, col = "#2a5060" }: any) => (
    <div style={{ padding: "14px 18px", background: "#060a14", border: "1px solid #0a1828", textAlign: "center" }}>
      <div style={{ color: col, fontSize: 18, fontWeight: "bold", fontFamily: F }}>{val}</div>
      <div style={{ color: "#0e2030", fontSize: 8, marginTop: 3, letterSpacing: 2 }}>{label}</div>
    </div>
  );
  return (
    <div style={{ fontFamily: F }}>
      <div style={{ padding: 20, border: "1px solid #00ffcc1a", background: "rgba(0,255,204,.02)", marginBottom: 14 }}>
        <div style={{ color: "#0e2030", fontSize: 8, letterSpacing: 3, marginBottom: 10 }}>YOUR NODE · WALLET</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#00ffcc", boxShadow: "0 0 12px #00ffcc", flexShrink: 0 }} />
          <div style={{ color: "#2a5060", fontSize: 12, wordBreak: "break-all" }}>{wallet.address}</div>
          <button onClick={copy} style={{ background: "transparent", border: "1px solid #0a2030", color: copied ? "#00ffcc" : "#1a3040", fontFamily: F, fontSize: 9, padding: "4px 10px", cursor: "pointer", letterSpacing: 1, flexShrink: 0 }}>
            {copied ? "COPIED" : "COPY"}
          </button>
        </div>
        <div style={{ color: "#00ffcc", fontSize: 36, fontWeight: "bold", textShadow: "0 0 30px #00ffcc55", marginBottom: 4 }}>
          {balance.toFixed(6)} <span style={{ fontSize: 16, color: "#2a6644" }}>$BLOB</span>
        </div>
        {pending > 0 && <div style={{ color: "#1a4455", fontSize: 10 }}>+{pending.toFixed(6)} pending</div>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 1, marginBottom: 14 }}>
        <Stat label="BLOCKS MINED" val={totalBlocks} col="#ffcc00" />
        <Stat label="TOTAL EARNED" val={totalMined.toFixed(2)} col="#00ffcc" />
        <Stat label="CHAIN HEIGHT" val={chain.length - 1} col="#3a86ff" />
      </div>
      <div style={{ padding: "12px 16px", border: "1px solid #0a1828", background: "#060a14" }}>
        <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>PUBLIC KEY (JWK)</div>
        <div style={{ color: "#0a1e2a", fontSize: 8, wordBreak: "break-all", lineHeight: 1.6 }}>{wallet.publicKey}</div>
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setShowPriv(!showPriv)} style={{ background: "transparent", border: "1px solid #ff224422", color: "#ff2244", fontFamily: F, fontSize: 9, padding: "5px 12px", cursor: "pointer", letterSpacing: 1 }}>
            {showPriv ? "HIDE PRIVATE KEY ▲" : "SHOW PRIVATE KEY ▼"}
          </button>
          {showPriv && (
            <div style={{ marginTop: 8, padding: "10px 12px", border: "1px solid #ff224422" }}>
              <div style={{ color: "#ff2244", fontSize: 9, marginBottom: 6 }}>⚠ NEVER share this key</div>
              <div style={{ color: "#1a2030", fontSize: 8, wordBreak: "break-all", lineHeight: 1.6 }}>{wallet.privateKey}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// 14. NETWORK / NODES VIEW ─────────────────────────────────────────────────────
function NetworkView({ nodeCount, chain, blockInfo }) {
  const totalTxs = chain.reduce((s, b) => s + (b.transactions || []).length, 0);
  const supply = calcTotalSupply(chain);
  const F = '"Courier New",monospace';
  const Stat = ({ l, v, c = "#2a5060" }: any) => (
    <div style={{ padding: 14, background: "#060a14", border: "1px solid #0a1828" }}>
      <div style={{ color: c, fontSize: 20, fontWeight: "bold" }}>{v}</div>
      <div style={{ color: "#0e2030", fontSize: 8, marginTop: 3, letterSpacing: 2 }}>{l}</div>
    </div>
  );
  return (
    <div style={{ fontFamily: F }}>
      <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 3, marginBottom: 14 }}>BLOB CHAIN NETWORK</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, marginBottom: 14 }}>
        <Stat l="ACTIVE NODES" v={nodeCount} c="#00ffcc" />
        <Stat l="CHAIN HEIGHT" v={chain.length - 1} c="#3a86ff" />
        <Stat l="TOTAL SUPPLY" v={supply.toFixed(2) + " $BLOB"} c="#ffcc00" />
        <Stat l="CONFIRMED TXS" v={totalTxs} c="#ff6b6b" />
      </div>
      <div style={{ padding: "14px 16px", border: "1px solid #0a1828", background: "#060a14", marginBottom: 10 }}>
        <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 2, marginBottom: 10 }}>HOW NODES WORK</div>
        {[
          "Every browser tab running this app is a full node",
          "Nodes receive transactions, validate them, and add to mempool",
          "Nodes receive score entries and independently compute the winner",
          "Winner is determined by weighted random lottery — higher score = higher chance",
          "All nodes verify the winning block before accepting it to the chain",
          "Realtime gossip is the network between nodes",
          "Persistent storage holds the canonical chain — nodes fetch on startup",
        ].map((t, i) => (
          <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "flex-start" }}>
            <span style={{ color: "#00ffcc", fontSize: 10, flexShrink: 0, marginTop: 1 }}>⬡</span>
            <span style={{ color: "#1a3040", fontSize: 10, lineHeight: 1.7 }}>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: "12px 16px", border: "1px solid #ffcc0011", background: "rgba(255,204,0,.015)" }}>
        <div style={{ color: "#0e2030", fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>CONSENSUS ALGORITHM</div>
        <div style={{ color: "#1a3040", fontSize: 10, lineHeight: 2 }}>
          Proof-of-Gaming (PoG) · Block time: {BLOCK_TIME}s · Max supply: {MAX_SUPPLY.toLocaleString()} $BLOB<br />
          Halving every {HALVING_BLOCKS.toLocaleString()} blocks · Current reward: {blockInfo.reward} $BLOB<br />
          Winner selection: deterministic weighted lottery seeded from block height<br />
          Score proof: ECDSA-signed (P-256) input submitted to all nodes<br />
          Level seed: derived from block height — identical for all miners
        </div>
      </div>
    </div>
  );
}

// 15. MAIN APP ─────────────────────────────────────────────────────────────────
export default function BlobChainApp() {
  const F = '"Courier New",monospace';

  const [wallet, setWallet] = useState<any>(null);
  const [nameIn, setNameIn] = useState("");
  const [creating, setCreating] = useState(false);

  const [chain, setChain] = useState<any[]>([GENESIS]);
  const [mempool, setMempool] = useState<any[]>([]);
  const [entries, setEntries] = useState<any[]>([]);
  const [myEntry, setMyEntry] = useState<any>(null);
  const [blockInfo, setBlock] = useState(getBlockInfo());
  const [nodeCount] = useState(1);
  const [newBlock, setNewBlock] = useState<any>(null);
  const [screen, setScreen] = useState("mine");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("blob_wallet_v2");
      if (saved) setWallet(JSON.parse(saved));
      const savedChain = localStorage.getItem("blob_chain_v2");
      if (savedChain) setChain(JSON.parse(savedChain));
    } catch {}
    document.title = "⬡ BLOB CHAIN — Proof-of-Gaming";
  }, []);

  useEffect(() => {
    try { localStorage.setItem("blob_chain_v2", JSON.stringify(chain)); } catch {}
  }, [chain]);

  async function createWallet() {
    if (!nameIn.trim()) return;
    setCreating(true);
    const w: any = await generateWallet();
    w.username = nameIn.trim().slice(0, 24);
    try { localStorage.setItem("blob_wallet_v2", JSON.stringify(w)); } catch {}
    setWallet(w);
    setCreating(false);
  }

  useEffect(() => {
    const iv = setInterval(() => setBlock(getBlockInfo()), 1000);
    return () => clearInterval(iv);
  }, []);

  // Keep latest values available to the sealing effect (avoid stale closures)
  const entriesRef = useRef(entries);
  const mempoolRef = useRef(mempool);
  const chainRef = useRef(chain);
  const walletRef = useRef(wallet);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => { mempoolRef.current = mempool; }, [mempool]);
  useEffect(() => { chainRef.current = chain; }, [chain]);
  useEffect(() => { walletRef.current = wallet; }, [wallet]);

  // Block sealing
  const prevHeightRef = useRef(blockInfo.height);
  useEffect(() => {
    const prevHeight = prevHeightRef.current;
    if (blockInfo.height !== prevHeight) {
      const closedHeight = blockInfo.height - 1;
      prevHeightRef.current = blockInfo.height;
      const closedEntries = entriesRef.current;
      const currentChain = chainRef.current;
      const currentMempool = mempoolRef.current;
      const currentWallet = walletRef.current;
      const prevBlock = currentChain.find(b => b.height === closedHeight) || currentChain[currentChain.length - 1];
      const seedNum = closedHeight * 6364136223846793 + 1442695040888963407;
      const winner = pickWinner(closedEntries, Math.abs(seedNum % 2147483647));
      const txsToInclude = currentMempool.slice(0, 50);
      const reward = getRewardForHeight(closedHeight);

      (async () => {
        const newB: any = {
          height: closedHeight,
          previousHash: prevBlock?.hash || GENESIS.hash,
          timestamp: Date.now(),
          transactions: txsToInclude,
          miningEntries: closedEntries,
          winner: winner?.address || null,
          winnerUsername: winner?.username || null,
          winnerScore: winner?.score || 0,
          reward: winner ? reward : 0,
          seed: String(closedHeight),
          nodeCount,
          totalSupply: calcTotalSupply(currentChain) + (winner ? reward : 0),
        };
        newB.hash = await computeBlockHash(newB);

        setChain(c => {
          if (c.find(b => b.height === closedHeight)) return c;
          return [...c, newB].sort((a, b2) => a.height - b2.height);
        });
        setMempool(m => m.filter(t => !txsToInclude.find(x => x.id === t.id)));
        setNewBlock({ ...newB, isMine: winner?.address === currentWallet?.address });
        setTimeout(() => setNewBlock(null), 5000);
        setEntries([]);
        setMyEntry(null);
      })();
    }
  }, [blockInfo.height]);

  const onEntrySubmit = useCallback(entry => {
    setMyEntry(entry);
    setEntries(e => e.find(x => x.address === entry.address) ? e.map(x => x.address === entry.address ? entry : x) : [...e, entry]);
  }, []);

  const onTxBroadcast = useCallback(tx => {
    setMempool(m => [...m, tx]);
  }, []);

  if (!wallet) {
    return (
      <div style={{ minHeight: "100vh", background: "#030508", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: F }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 28 }}>
          <div style={{ fontSize: 44, fontWeight: "bold", color: "#00ffcc", letterSpacing: 8, textShadow: "0 0 50px #00ffcc77", marginBottom: 6 }}>⬡ BLOB</div>
          <div style={{ color: "#0a1e28", fontSize: 10, letterSpacing: 5, marginBottom: 10 }}>PROOF-OF-GAMING BLOCKCHAIN</div>
          <div style={{ color: "#0a1828", fontSize: 9, marginBottom: 40, lineHeight: 2 }}>
            Bitcoin clone · $BLOB token · 0 premine · Gameplay-mined
          </div>
          <div style={{ color: "#1a3040", fontSize: 10, marginBottom: 12, textAlign: "left" }}>Miner name</div>
          <input value={nameIn} onChange={e => setNameIn(e.target.value)} onKeyDown={e => e.key === "Enter" && !creating && createWallet()}
            placeholder="SatoshiBlob…" maxLength={24}
            style={{ width: "100%", padding: "13px 16px", background: "transparent", border: "2px solid #00ffcc22", color: "#00ffcc", fontFamily: F, fontSize: 14, letterSpacing: 2, outline: "none", boxSizing: "border-box", marginBottom: 12 }}
          />
          <button onClick={createWallet} disabled={creating || !nameIn.trim()} style={{ width: "100%", padding: 14, background: "transparent", border: "2px solid #00ffcc", color: "#00ffcc", fontFamily: F, fontSize: 13, letterSpacing: 4, cursor: "pointer", fontWeight: "bold", opacity: nameIn.trim() ? 1 : .5 }}>
            {creating ? "GENERATING KEYPAIR…" : "GENERATE WALLET & JOIN NETWORK"}
          </button>
          <div style={{ marginTop: 20, color: "#061018", fontSize: 9, lineHeight: 2.4 }}>
            ECDSA P-256 keypair generated in your browser<br />
            Private key stored locally · Never leaves your device<br />
            Your browser tab = a full node on the network
          </div>
        </div>
      </div>
    );
  }

  const balance = calcBalance(wallet.address, chain);
  const nav = [
    { id: "mine", text: "MINE" },
    { id: "wallet", text: "WALLET" },
    { id: "send", text: "SEND" },
    { id: "mempool", text: "MEMPOOL" },
    { id: "chain", text: "EXPLORER" },
    { id: "network", text: "NETWORK" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#030508", fontFamily: F, paddingBottom: 40 }}>
      {newBlock && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000, padding: "12px 24px", background: newBlock.isMine ? "rgba(0,255,204,.18)" : "rgba(10,20,40,.96)", borderBottom: `2px solid ${newBlock.isMine ? "#00ffcc" : "#ffcc00"}`, textAlign: "center", display: "flex", justifyContent: "center", alignItems: "center", gap: 20 }}>
          <span style={{ color: newBlock.isMine ? "#00ffcc" : "#ffcc00", fontSize: 14, fontWeight: "bold", letterSpacing: 3 }}>
            {newBlock.isMine ? "🏆 YOU MINED BLOCK" : "⬡ NEW BLOCK"} #{newBlock.height}
          </span>
          <span style={{ color: "#2a5060", fontSize: 11 }}>
            Winner: {newBlock.winnerUsername || "—"} · Score: {newBlock.winnerScore?.toLocaleString()} · Reward: {newBlock.reward} $BLOB
          </span>
        </div>
      )}

      <div style={{ borderBottom: "1px solid #07101a", background: "#040710", padding: "0 20px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 50, position: "sticky", top: 0, zIndex: 90 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <h1 style={{ color: "#00ffcc", fontWeight: "bold", fontSize: 16, letterSpacing: 5, textShadow: "0 0 16px #00ffcc44", margin: 0 }}>⬡ BLOB</h1>
          <div style={{ color: "#0a1e28", fontSize: 8, letterSpacing: 2 }}>PoG</div>
        </div>
        <div style={{ display: "flex", gap: 1 }}>
          {nav.map(n => (
            <button key={n.id} onClick={() => setScreen(n.id)} style={{
              background: screen === n.id ? "rgba(0,255,204,.06)" : "transparent",
              border: screen === n.id ? "1px solid #00ffcc1a" : "1px solid transparent",
              color: screen === n.id ? "#00ffcc" : "#1a3a4a",
              padding: "5px 14px", fontFamily: F, fontSize: 9, letterSpacing: 2, cursor: "pointer",
            }}>{n.text}</button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#00ffcc", boxShadow: "0 0 8px #00ffcc" }} />
          <span style={{ color: "#1a4455", fontSize: 10 }}>{wallet.username}</span>
          <span style={{ color: "#00ffcc", fontSize: 10, marginLeft: 4 }}>{balance.toFixed(4)} $BLOB</span>
          <span style={{ fontSize: 9, marginLeft: 8, borderLeft: "1px solid #0a1828", paddingLeft: 10, color: blockInfo.remaining < 20 ? "#ff4422" : "#0a1e28" }}>
            {blockInfo.remaining}s
          </span>
        </div>
      </div>

      <div style={{ padding: 20, maxWidth: 860, margin: "0 auto" }}>
        {screen === "mine" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <BlobRunGame wallet={wallet} blockInfo={blockInfo} onEntrySubmit={onEntrySubmit} myEntry={myEntry} />
            <MiningPanel blockInfo={blockInfo} entries={entries} myEntry={myEntry} chain={chain} />
          </div>
        )}
        {screen === "wallet" && <WalletScreen wallet={wallet} chain={chain} mempool={mempool} />}
        {screen === "send" && <SendTx wallet={wallet} chain={chain} onBroadcast={onTxBroadcast} />}
        {screen === "mempool" && <Mempool mempool={mempool} wallet={wallet} />}
        {screen === "chain" && <BlockExplorer chain={chain} blockInfo={blockInfo} />}
        {screen === "network" && <NetworkView nodeCount={nodeCount} chain={chain} blockInfo={blockInfo} />}
      </div>

      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, borderTop: "1px solid #07101a", background: "#040710", padding: "6px 20px", display: "flex", justifyContent: "space-between", color: "#0a1e28", fontSize: 8, letterSpacing: 2, fontFamily: F }}>
        <span>⬡ BLOB CHAIN · PROOF-OF-GAMING</span>
        <span>BLOCK #{blockInfo.height} · SEED {blockInfo.seed} · {blockInfo.remaining}s</span>
        <span>{chain.length - 1} BLOCKS · {calcTotalSupply(chain).toFixed(2)} / {MAX_SUPPLY.toLocaleString()}</span>
      </div>
    </div>
  );
}
