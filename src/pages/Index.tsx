// @ts-nocheck
// ═══════════════════════════════════════════════════════════════════════════════
// ⬡ BLOB CHAIN — Proof-of-Gaming Blockchain (single-node local build)
// Bitcoin clone: $BLOB token, 0 starting supply, gameplay-mined
// Real ECDSA wallet · SHA-256 block hashing · Weighted lottery consensus
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from "react";
import * as Relay from "@/lib/blobRelay";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Send, Play } from "lucide-react";
import runnerArt from "@/assets/runner.png";

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
  // Deep gradient sky
  const sky = ctx.createLinearGradient(0, 0, 0, GY);
  sky.addColorStop(0, "#070b18");
  sky.addColorStop(1, "#0a1828");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, CW, GY);

  // Soft glow horizon
  const halo = ctx.createRadialGradient(CW / 2, GY, 10, CW / 2, GY, CW * 0.7);
  halo.addColorStop(0, "rgba(0, 255, 204, 0.10)");
  halo.addColorStop(1, "rgba(0, 255, 204, 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, CW, GY);

  // Distant parallax dots / nodes
  nodes.forEach(n => {
    ctx.save();
    ctx.globalAlpha = n.a;
    ctx.fillStyle = "#7ad9c5";
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  // Subtle parallax grid lines on ground
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

  // Crisp horizon line
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

function drawBlob(ctx, x, y, action, wob, sq, blink) {
  const duck = action === "duck";
  const rx = duck ? 32 : 22, ry = duck ? 16 : 28;
  const wb = Math.sin(wob * .12) * (duck ? 1.5 : 2.5);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, sq);

  // Soft outer glow
  ctx.shadowColor = "#00ffcc";
  ctx.shadowBlur = 24;

  // Body gradient
  const bodyGrad = ctx.createRadialGradient(-4, -6, 2, 0, 0, rx + 6);
  bodyGrad.addColorStop(0, "#7dffe0");
  bodyGrad.addColorStop(1, "#00d6a8");
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(0, -ry);
  ctx.bezierCurveTo(rx + wb, -ry * .7, rx + wb, ry * .7, 0, ry);
  ctx.bezierCurveTo(-rx - wb, ry * .7, -rx - wb, -ry * .7, 0, -ry);
  ctx.fill();

  ctx.shadowBlur = 0;
  // Highlight
  ctx.fillStyle = "rgba(255,255,255,.22)";
  ctx.beginPath();
  ctx.ellipse(-5, -9, rx * .42, ry * .28, -.3, 0, Math.PI * 2);
  ctx.fill();

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
  } else {
    ctx.fillStyle = "#001510";
    ctx.beginPath(); ctx.ellipse(-8, 0, 4.5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(8, 0, 4.5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawFork(ctx, o) {
  // Modern minimal obstacle: glowing vertical bar with cap
  ctx.save();
  const cx = o.x + o.w / 2;
  // Soft glow halo
  const grad = ctx.createLinearGradient(cx, o.y, cx, o.y + o.h);
  grad.addColorStop(0, "rgba(255, 90, 110, 0.95)");
  grad.addColorStop(1, "rgba(255, 90, 110, 0.55)");
  ctx.shadowColor = "#ff5a6e";
  ctx.shadowBlur = 18;
  ctx.fillStyle = grad;
  // Pill shape
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
  // Inner highlight
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x + 2, y + 4, 2, h - 8);
  ctx.restore();
}

function drawToken(ctx, tx, ty, frame) {
  const p = Math.sin(frame * .08 + tx * .009) * 2.5;
  ctx.save();
  ctx.translate(tx, ty + p);
  // Outer halo
  const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, 18);
  grad.addColorStop(0, "rgba(120, 200, 255, 0.6)");
  grad.addColorStop(1, "rgba(120, 200, 255, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2); ctx.fill();
  // Coin
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
      ctx.fillText(`${blockInfo.reward} $BLOB`, CW - 26, 42);

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


  return (
    <div className="space-y-2">
      <div className="relative rounded-2xl overflow-hidden border border-glass-border" style={{ lineHeight: 0, boxShadow: "0 20px 60px hsl(220 50% 2% / 0.6)" }}>
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

// 9. SEND TX FORM ──────────────────────────────────────────────────────────────
function SendTxForm({ wallet, chain, onBroadcast, onSent }: any) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [st, setSt] = useState("idle");
  const [err, setErr] = useState("");
  const balance = calcBalance(wallet.address, chain);

  async function send() {
    setErr("");
    const amount = parseFloat(amt);
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
      setTimeout(() => { setSt("idle"); onSent?.(); }, 1500);
    } catch (e) { setErr(String(e)); setSt("idle"); }
  }

  const disabled = st !== "idle";
  const label = st === "idle" ? "Broadcast transaction"
              : st === "signing" ? "Signing…"
              : st === "broadcasting" ? "Broadcasting…"
              : "✓ Sent";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Available</span>
        <span className="num text-primary">{balance.toFixed(6)} $BLOB</span>
      </div>
      <div className="space-y-2">
        <label className="label-eyebrow block">Recipient</label>
        <input
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="0x…"
          className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num placeholder:text-muted-foreground/60"
        />
      </div>
      <div className="space-y-2">
        <label className="label-eyebrow block">Amount</label>
        <div className="relative">
          <input
            value={amt}
            onChange={e => setAmt(e.target.value)}
            type="number"
            min="0"
            step="0.000001"
            placeholder="0.00"
            className="w-full px-4 py-3 pr-20 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num placeholder:text-muted-foreground/60"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$BLOB</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Network fee</span>
        <span className="num">{TX_FEE} $BLOB → miner</span>
      </div>
      {err && <div className="text-xs text-destructive">{err}</div>}
      {st === "sent" && <div className="text-xs text-primary">✓ Broadcast to mempool</div>}
      <button
        onClick={send}
        disabled={disabled}
        className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {label}
      </button>
    </div>
  );
}

// 10. MINING PANEL ─────────────────────────────────────────────────────────────
function MiningPanel({ blockInfo, entries, myEntry, chain }: any) {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const total = entries.reduce((s: number, e: any) => s + e.score, 0);
  const supplyNow = calcTotalSupply(chain);

  const Stat = ({ label, value, accent = "text-foreground" }: any) => (
    <div className="glass p-4">
      <div className={`num text-xl font-semibold ${accent}`}>{value}</div>
      <div className="label-eyebrow mt-1">{label}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Stat label="Block" value={`#${blockInfo.height}`} accent="text-primary" />
        <Stat label="Reward" value={`${blockInfo.reward} $BLOB`} accent="text-[hsl(var(--warning))]" />
        <Stat label="Remaining" value={`${blockInfo.remaining}s`} accent="text-[hsl(var(--info))]" />
        <Stat label="Miners" value={entries.length} />
      </div>

      <div className="glass p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="label-eyebrow">$BLOB Supply</span>
          <span className="text-xs num text-muted-foreground">
            {supplyNow.toFixed(2)} / {MAX_SUPPLY.toLocaleString()}
          </span>
        </div>
        <div className="h-1 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-500"
            style={{ width: `${Math.min((supplyNow / MAX_SUPPLY) * 100, 100)}%` }}
          />
        </div>
      </div>

      <div>
        <div className="label-eyebrow mb-3">Current block entries</div>
        {entries.length === 0 ? (
          <div className="glass p-8 text-center text-sm text-muted-foreground">
            No entries yet — play Blob Run to submit yours
          </div>
        ) : (
          <div className="space-y-1.5">
            {sorted.map((e: any, i: number) => {
              const pct = total > 0 ? +((e.score / total) * 100).toFixed(1) : 0;
              const isMe = e.address === myEntry?.address;
              return (
                <div
                  key={e.address + i}
                  className={`glass px-4 py-3 flex items-center gap-3 ${isMe ? "ring-1 ring-primary/40" : ""}`}
                >
                  <span className="w-6 text-sm">
                    {i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : <span className="text-muted-foreground">{i + 1}</span>}
                  </span>
                  <span className={`flex-1 text-sm truncate ${isMe ? "text-primary" : "text-foreground/80"}`}>
                    {e.username || e.address?.slice(0, 14)}
                  </span>
                  <span className="num text-sm font-medium">{e.score.toLocaleString()}</span>
                  <div className="w-24 h-1 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={`h-full ${isMe ? "bg-primary" : i === 0 ? "bg-[hsl(var(--warning))]" : "bg-muted-foreground"}`}
                      style={{ width: `${Math.min(pct, 100)}%` }}
                    />
                  </div>
                  <span className="num text-xs w-12 text-right text-muted-foreground">{pct}%</span>
                </div>
              );
            })}
          </div>
        )}
        {myEntry && (
          <div className="mt-3 text-xs text-center text-muted-foreground">
            Your win probability: <span className="text-primary num">{winProbability(myEntry.score, entries)}%</span>
            {" · weighted random lottery"}
          </div>
        )}
      </div>
    </div>
  );
}

// 11. BLOCK EXPLORER ──────────────────────────────────────────────────────────
function BlockExplorer({ chain, blockInfo }: any) {
  const [sel, setSel] = useState<number | null>(null);
  const display = [...chain].reverse().slice(0, 30);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between glass px-4 py-3">
        <span className="text-sm">⬡ BLOB Chain</span>
        <span className="text-xs text-muted-foreground num">{chain.length} blocks</span>
      </div>

      <div className="glass-hi px-4 py-3 ring-1 ring-[hsl(var(--warning)/0.2)]">
        <div className="grid grid-cols-[60px_1fr_80px_100px_50px] gap-3 items-center text-sm">
          <span className="num text-[hsl(var(--warning))]">#{blockInfo.height}</span>
          <span className="text-muted-foreground">🕒 mining…</span>
          <span className="text-muted-foreground">—</span>
          <span className="num text-[hsl(var(--warning))]">{blockInfo.reward} $BLOB</span>
          <span className="text-muted-foreground num text-right">—</span>
        </div>
      </div>

      <div className="grid grid-cols-[60px_1fr_80px_100px_50px] gap-3 px-4 py-2">
        {["Height", "Winner", "Score", "Reward", "Txs"].map(h => (
          <div key={h} className="label-eyebrow">{h}</div>
        ))}
      </div>

      {display.map((b: any) => (
        <div key={b.height}>
          <div
            onClick={() => setSel(sel === b.height ? null : b.height)}
            className="glass px-4 py-3 cursor-pointer hover:bg-secondary/30 transition grid grid-cols-[60px_1fr_80px_100px_50px] gap-3 items-center text-sm"
          >
            <span className="num text-muted-foreground">#{b.height}</span>
            <span className="truncate text-foreground/80">{b.winnerUsername || b.winner?.slice(0, 18) || "—"}</span>
            <span className="num text-muted-foreground">{b.winnerScore > 0 ? b.winnerScore : "—"}</span>
            <span className="num text-primary/80">{b.reward > 0 ? `${b.reward} ⬡` : "—"}</span>
            <span className="num text-right text-muted-foreground">{(b.transactions || []).length}</span>
          </div>
          {sel === b.height && (
            <div className="glass mt-1 p-4 text-xs text-muted-foreground space-y-1.5 overflow-x-auto">
              <div><span className="label-eyebrow mr-2">Hash</span><span className="num text-foreground/70">{b.hash}</span></div>
              <div><span className="label-eyebrow mr-2">Prev</span><span className="num text-foreground/70">{b.previousHash?.slice(0, 40)}…</span></div>
              <div><span className="label-eyebrow mr-2">Seed</span><span className="num">{b.seed}</span></div>
              <div><span className="label-eyebrow mr-2">Time</span>{new Date(b.timestamp).toLocaleString()}</div>
              <div><span className="label-eyebrow mr-2">Winner</span><span className="num text-foreground/70">{b.winner || "—"}</span></div>
              {(b.transactions || []).map((tx: any, i: number) => (
                <div key={i} className="num text-foreground/60">
                  TX · {tx.fromUsername || tx.from?.slice(0, 10)} → {tx.to?.slice(0, 10)} · {tx.amount} $BLOB
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {chain.length <= 1 && (
        <div className="glass text-center py-10 text-sm text-muted-foreground">
          Chain starts at genesis · Mine the first block to begin
        </div>
      )}
    </div>
  );
}

// 12. MEMPOOL VIEW ─────────────────────────────────────────────────────────────
function Mempool({ mempool, wallet }: any) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="label-eyebrow">Pending transactions</span>
        <span className="text-xs text-muted-foreground num">{mempool.length} unconfirmed</span>
      </div>
      {mempool.length === 0 ? (
        <div className="glass text-center py-10 text-sm text-muted-foreground">
          No pending transactions · Mempool empty
        </div>
      ) : (
        <div className="space-y-2">
          {mempool.map((tx: any, i: number) => {
            const isMe = tx.from === wallet.address;
            return (
              <div
                key={tx.id || i}
                className={`glass px-4 py-3 border-l-2 ${isMe ? "border-l-primary" : "border-l-muted"}`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-foreground/80">{tx.fromUsername || tx.from?.slice(0, 16) + "…"}</span>
                  <span className="num text-sm font-medium text-primary/90">{tx.amount} $BLOB</span>
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="num">fee {tx.fee || TX_FEE}</span>
                  <span className="num">{new Date(tx.timestamp).toLocaleTimeString()}</span>
                  <span>⧗ pending</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 13. WALLET SCREEN (Send lives here) ─────────────────────────────────────────
function WalletScreen({ wallet, chain, mempool, onBroadcast }: any) {
  const [showPriv, setShowPriv] = useState(false);
  const [copied, setCopied] = useState(false);
  const balance = calcBalance(wallet.address, chain);
  const pending = mempool
    .filter((tx: any) => tx.to === wallet.address)
    .reduce((s: number, tx: any) => s + tx.amount, 0);
  const totalBlocks = chain.filter((b: any) => b.winner === wallet.address).length;
  const totalMined = chain
    .filter((b: any) => b.winner === wallet.address)
    .reduce((s: number, b: any) => s + (b.reward || 0), 0);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <div className="glass-hi p-6">
          <div className="label-eyebrow mb-4">Your wallet</div>
          <div className="flex items-center gap-3 mb-6">
            <div className="w-2 h-2 rounded-full bg-primary shadow-[0_0_12px_hsl(var(--primary))]" />
            <div className="num text-sm text-foreground/80 truncate flex-1">{wallet.address}</div>
            <button
              onClick={copy}
              className="px-3 py-1 rounded-md text-xs border border-border hover:border-primary/40 hover:text-primary transition"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="num text-5xl font-semibold text-primary leading-none mb-2">
            {balance.toFixed(6)}
            <span className="text-base text-muted-foreground ml-2">$BLOB</span>
          </div>
          {pending > 0 && (
            <div className="text-xs text-muted-foreground num">+{pending.toFixed(6)} pending</div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="glass p-4">
            <div className="num text-2xl font-semibold text-[hsl(var(--warning))]">{totalBlocks}</div>
            <div className="label-eyebrow mt-1">Blocks mined</div>
          </div>
          <div className="glass p-4">
            <div className="num text-2xl font-semibold text-primary">{totalMined.toFixed(2)}</div>
            <div className="label-eyebrow mt-1">Total earned</div>
          </div>
          <div className="glass p-4">
            <div className="num text-2xl font-semibold text-[hsl(var(--info))]">{chain.length - 1}</div>
            <div className="label-eyebrow mt-1">Chain height</div>
          </div>
        </div>

        <div className="glass p-4">
          <div className="label-eyebrow mb-2">Public key (JWK)</div>
          <div className="num text-[10px] text-muted-foreground/80 break-all leading-relaxed">
            {wallet.publicKey}
          </div>
          <button
            onClick={() => setShowPriv(!showPriv)}
            className="mt-3 px-3 py-1 rounded-md text-xs border border-destructive/30 text-destructive hover:bg-destructive/10 transition"
          >
            {showPriv ? "Hide private key ▲" : "Show private key ▼"}
          </button>
          {showPriv && (
            <div className="mt-3 p-3 rounded-md border border-destructive/30 bg-destructive/5">
              <div className="text-xs text-destructive mb-2">⚠ Never share this key</div>
              <div className="num text-[10px] text-foreground/60 break-all leading-relaxed">{wallet.privateKey}</div>
            </div>
          )}
        </div>
      </div>

      <div className="lg:col-span-1">
        <div className="glass-hi p-6 lg:sticky lg:top-20">
          <div className="label-eyebrow mb-4">Send $BLOB</div>
          <SendTxForm wallet={wallet} chain={chain} onBroadcast={onBroadcast} />
        </div>
      </div>
    </div>
  );
}

// 14. NETWORK / NODES VIEW ─────────────────────────────────────────────────────
function NetworkView({ nodeCount, chain, blockInfo }: any) {
  const totalTxs = chain.reduce((s: number, b: any) => s + (b.transactions || []).length, 0);
  const supply = calcTotalSupply(chain);

  const Stat = ({ l, v, c = "text-foreground" }: any) => (
    <div className="glass p-4">
      <div className={`num text-2xl font-semibold ${c}`}>{v}</div>
      <div className="label-eyebrow mt-1">{l}</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="label-eyebrow">BLOB Chain network</div>
      <div className="grid grid-cols-2 gap-2">
        <Stat l="Active nodes" v={nodeCount} c="text-primary" />
        <Stat l="Chain height" v={chain.length - 1} c="text-[hsl(var(--info))]" />
        <Stat l="Total supply" v={`${supply.toFixed(2)} $BLOB`} c="text-[hsl(var(--warning))]" />
        <Stat l="Confirmed txs" v={totalTxs} c="text-foreground" />
      </div>

      <div className="glass p-5">
        <div className="label-eyebrow mb-3">How nodes work</div>
        <div className="space-y-2">
          {[
            "Every browser tab running this app is a full node",
            "Nodes receive transactions, validate them, and add to mempool",
            "Nodes receive score entries and independently compute the winner",
            "Winner is determined by weighted random lottery — higher score = higher chance",
            "All nodes verify the winning block before accepting it to the chain",
            "Realtime gossip is the network between nodes",
            "Persistent storage holds the canonical chain — nodes fetch on startup",
          ].map((t, i) => (
            <div key={i} className="flex gap-3 text-sm text-foreground/70">
              <span className="text-primary mt-1">⬡</span>
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="glass p-5">
        <div className="label-eyebrow mb-3">Consensus algorithm</div>
        <div className="text-sm text-foreground/70 space-y-1.5">
          <div>Proof-of-Gaming · Block time: <span className="num">{BLOCK_TIME}s</span> · Max supply: <span className="num">{MAX_SUPPLY.toLocaleString()}</span> $BLOB</div>
          <div>Halving every <span className="num">{HALVING_BLOCKS.toLocaleString()}</span> blocks · Current reward: <span className="num">{blockInfo.reward}</span> $BLOB</div>
          <div>Winner selection: deterministic weighted lottery seeded from block height</div>
          <div>Score proof: ECDSA-signed (P-256) input submitted to all nodes</div>
          <div>Level seed: derived from block height — identical for all miners</div>
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
    } catch {}
    document.title = "⬡ BLOB CHAIN — Proof-of-Gaming";
  }, []);

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

  // ── P2P RELAY: initial load + realtime subscription ────────────────────
  const currentHeightRef = useRef(blockInfo.height);
  useEffect(() => { currentHeightRef.current = blockInfo.height; }, [blockInfo.height]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [c, m, e] = await Promise.all([
        Relay.fetchChain(),
        Relay.fetchMempool(),
        Relay.fetchEntries(currentHeightRef.current),
      ]);
      if (cancelled) return;
      if (c.length) setChain(c);
      setMempool(m);
      setEntries(e);
    })();

    const unsub = Relay.subscribeRelay({
      onBlock: (b) => {
        setChain(prev => {
          if (prev.find(x => x.height === b.height)) return prev;
          return [...prev, b].sort((a, b2) => a.height - b2.height);
        });
        setNewBlock({ ...b, isMine: b.winner === walletRef.current?.address });
        setTimeout(() => setNewBlock(null), 5000);
        // entries from a closed block no longer apply to the new round
        if (b.height >= currentHeightRef.current - 1) {
          setEntries([]);
          setMyEntry(null);
        }
      },
      onTx: (t) => {
        setMempool(prev => prev.find(x => x.id === t.id) ? prev : [...prev, t]);
      },
      onTxRemoved: (id) => {
        setMempool(prev => prev.filter(x => x.id !== id));
      },
      onEntry: (en) => {
        if (en.block_height !== currentHeightRef.current) return;
        setEntries(prev => {
          const i = prev.findIndex(x => x.address === en.address);
          if (i === -1) return [...prev, en];
          const copy = prev.slice(); copy[i] = en; return copy;
        });
      },
    });
    return () => { cancelled = true; unsub(); };
  }, []);

  // When the height ticks, refresh entries for the new round from the relay
  useEffect(() => {
    (async () => {
      const e = await Relay.fetchEntries(blockInfo.height);
      setEntries(e);
    })();
  }, [blockInfo.height]);

  // Block sealing — leader-elects locally, persists to relay (idempotent on PK)
  const prevHeightRef = useRef(blockInfo.height);
  useEffect(() => {
    const prevHeight = prevHeightRef.current;
    if (blockInfo.height === prevHeight) return;
    const closedHeight = blockInfo.height - 1;
    prevHeightRef.current = blockInfo.height;

    (async () => {
      // Pull the authoritative entry set for the closed block from the relay
      // so every node converges on the same winner.
      const closedEntries = await Relay.fetchEntries(closedHeight);
      const currentChain = chainRef.current;
      const currentMempool = mempoolRef.current;
      const currentWallet = walletRef.current;
      if (currentChain.find(b => b.height === closedHeight)) return; // already sealed
      const prevBlock = currentChain.find(b => b.height === closedHeight - 1)
        || currentChain[currentChain.length - 1];
      const seedNum = closedHeight * 6364136223846793 + 1442695040888963407;
      const winner = pickWinner(closedEntries, Math.abs(seedNum % 2147483647));
      const txsToInclude = currentMempool.slice(0, 50);
      const baseReward = getRewardForHeight(closedHeight);
      const feeTotal = txsToInclude.reduce((s, t) => s + (Number(t.fee) || 0), 0);
      const reward = winner ? baseReward + feeTotal : 0;

      const newB: any = {
        height: closedHeight,
        previousHash: prevBlock?.hash || GENESIS.hash,
        timestamp: Date.now(),
        transactions: txsToInclude,
        miningEntries: closedEntries,
        winner: winner?.address || null,
        winnerUsername: winner?.username || null,
        winnerScore: winner?.score || 0,
        reward,
        seed: String(closedHeight),
        nodeCount,
        totalSupply: calcTotalSupply(currentChain) + reward,
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

      // Best-effort persistence; PK collision is fine (another node won the race).
      Relay.pushBlock(newB);
      if (txsToInclude.length) Relay.clearTxs(txsToInclude.map(t => t.id));
    })();
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
      <div className="min-h-screen flex items-center justify-center px-6 relative">
        <div className="w-full max-w-md text-center relative z-10">
          <div className="num text-5xl font-semibold tracking-[0.3em] text-primary mb-2 drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">
            ⬡ BLOB
          </div>
          <div className="label-eyebrow mb-3">Proof-of-Gaming Blockchain</div>
          <div className="text-xs text-muted-foreground mb-10 leading-relaxed">
            Bitcoin clone · $BLOB token · 0 premine · Gameplay-mined
          </div>

          <div className="glass-hi p-6 text-left space-y-4">
            <div>
              <label className="label-eyebrow block mb-2">Miner name</label>
              <input
                value={nameIn}
                onChange={e => setNameIn(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !creating && createWallet()}
                placeholder="SatoshiBlob…"
                maxLength={24}
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <button
              onClick={createWallet}
              disabled={creating || !nameIn.trim()}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {creating ? "Generating keypair…" : "Generate wallet & join network"}
            </button>
            <div className="text-[11px] text-muted-foreground/80 leading-relaxed text-center pt-2">
              ECDSA P-256 keypair generated in your browser<br />
              Private key stored locally · Never leaves your device
            </div>
          </div>
        </div>
      </div>
    );
  }

  const balance = calcBalance(wallet.address, chain);
  const nav = [
    { id: "mine", text: "Mine" },
    { id: "wallet", text: "Wallet" },
    { id: "mempool", text: "Mempool" },
    { id: "chain", text: "Explorer" },
    { id: "network", text: "Network" },
  ];

  return (
    <div className="min-h-screen pb-16 relative">
      {newBlock && (
        <div
          className={`fixed top-0 left-0 right-0 z-[1000] px-6 py-3 backdrop-blur-xl border-b text-center flex justify-center items-center gap-5 ${
            newBlock.isMine
              ? "bg-primary/15 border-primary/50"
              : "bg-card/80 border-[hsl(var(--warning)/0.4)]"
          }`}
        >
          <span className={`text-sm font-semibold tracking-wide ${newBlock.isMine ? "text-primary" : "text-[hsl(var(--warning))]"}`}>
            {newBlock.isMine ? "🏆 You mined block" : "⬡ New block"} #{newBlock.height}
          </span>
          <span className="text-xs text-muted-foreground">
            Winner: {newBlock.winnerUsername || "—"} · Score: <span className="num">{newBlock.winnerScore?.toLocaleString()}</span> · Reward: <span className="num text-foreground/80">{newBlock.reward} $BLOB</span>
          </span>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/70 border-b border-border">
        <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold tracking-[0.25em] text-primary drop-shadow-[0_0_12px_hsl(var(--primary)/0.4)]">⬡ BLOB</h1>
            <span className="label-eyebrow hidden sm:inline">PoG</span>
          </div>

          <nav className="flex items-center gap-1">
            {nav.map(n => (
              <button
                key={n.id}
                onClick={() => setScreen(n.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                  screen === n.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`}
              >
                {n.text}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <Dialog>
              <DialogTrigger asChild>
                <button
                  className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 transition"
                  aria-label="Quick send"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send
                </button>
              </DialogTrigger>
              <DialogContent className="glass-hi border-border max-w-md">
                <DialogHeader>
                  <DialogTitle className="text-sm font-medium">Send $BLOB</DialogTitle>
                </DialogHeader>
                <SendTxForm wallet={wallet} chain={chain} onBroadcast={onTxBroadcast} />
              </DialogContent>
            </Dialog>

            <div className="hidden md:flex items-center gap-2 text-xs">
              <div className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
              <span className="text-muted-foreground">{wallet.username}</span>
              <span className="num text-primary">{balance.toFixed(4)}</span>
            </div>
            <div className={`num text-xs px-2 py-1 rounded-md border border-border ${blockInfo.remaining < 20 ? "text-destructive border-destructive/40" : "text-muted-foreground"}`}>
              {blockInfo.remaining}s
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 relative z-10">
        {screen === "mine" && (
          <div className="space-y-5">
            <BlobRunGame wallet={wallet} blockInfo={blockInfo} onEntrySubmit={onEntrySubmit} myEntry={myEntry} />
            <MiningPanel blockInfo={blockInfo} entries={entries} myEntry={myEntry} chain={chain} />
          </div>
        )}
        {screen === "wallet" && <WalletScreen wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />}
        {screen === "mempool" && <Mempool mempool={mempool} wallet={wallet} />}
        {screen === "chain" && <BlockExplorer chain={chain} blockInfo={blockInfo} />}
        {screen === "network" && <NetworkView nodeCount={nodeCount} chain={chain} blockInfo={blockInfo} />}
      </main>

      <footer className="fixed bottom-0 left-0 right-0 backdrop-blur-xl bg-background/70 border-t border-border px-5 py-2 flex justify-between items-center text-[10px] text-muted-foreground/70 num">
        <span className="hidden sm:inline">⬡ BLOB CHAIN · Proof-of-Gaming</span>
        <span>Block #{blockInfo.height} · {blockInfo.remaining}s</span>
        <span>{chain.length - 1} blocks · {calcTotalSupply(chain).toFixed(2)} / {MAX_SUPPLY.toLocaleString()}</span>
      </footer>
    </div>
  );
}
