// @ts-nocheck
// ═══════════════════════════════════════════════════════════════════════════════
// ⬡ BLOB CHAIN — Proof-of-Gaming Blockchain (single-node local build)
// Bitcoin clone: $BLOB token, 0 starting supply, gameplay-mined
// Real ECDSA wallet · SHA-256 block hashing · Weighted lottery consensus
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback } from "react";
import * as Relay from "@/lib/blobRelay";
import * as Vault from "@/lib/walletVault";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Send, Play, Wallet, Plus, Download, Lock, Settings as SettingsIcon, LogOut, ChevronDown, ArrowDownLeft, ArrowUpRight, Trophy, Eye, EyeOff } from "lucide-react";
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

// Bitcoin-style secp256k1 wallet.
//   privateKey : 64-char hex (32 bytes)
//   publicKey  : 66-char hex (33-byte compressed SEC1 point)
//   address    : Base58Check P2PKH ("1..." mainnet-style version 0x00)
const b58check = base58check(sha256);

function bytesToHex(b: Uint8Array) {
  let s = ""; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0"); return s;
}
function hexToBytes(h: string) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function pubKeyToAddress(pubHex: string) {
  const pub = hexToBytes(pubHex);
  const h160 = ripemd160(sha256(pub));
  const payload = new Uint8Array(1 + 20);
  payload[0] = 0x00; // P2PKH version byte
  payload.set(h160, 1);
  return b58check.encode(payload);
}

async function generateWallet() {
  const priv = secp.utils.randomPrivateKey();
  const pub = secp.getPublicKey(priv, true); // compressed
  const privateKey = bytesToHex(priv);
  const publicKey = bytesToHex(pub);
  const address = pubKeyToAddress(publicKey);
  return { address, publicKey, privateKey };
}

async function signData(privHex: string, data: string) {
  try {
    const msgHash = sha256(enc.encode(data));
    const sig = await secp.signAsync(msgHash, hexToBytes(privHex));
    return sig.toCompactHex(); // 128 hex chars (r||s)
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

  // Auto-start when mounted
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
    if (!to || to.length < 26 || to.length > 35 || !/^[1][1-9A-HJ-NP-Za-km-z]+$/.test(to)) {
      setErr("Invalid address"); return;
    }
    if (!amount || amount <= 0) { setErr("Invalid amount"); return; }
    if (amount + TX_FEE > balance) { setErr(`Insufficient balance (need ${(amount + TX_FEE).toFixed(6)})`); return; }
    setSt("signing");
    try {
      const ts = Date.now();
      const txid = await sha256hex(`${wallet.address}${to}${amount}${ts}`);
      const data = `${wallet.address}→${to}:${amount}@${ts}`;
      const sig = await signData(wallet.privateKey, data);
      const tx = {
        id: txid.slice(0, 40),
        from: wallet.address, fromUsername: wallet.username,
        to, amount, fee: TX_FEE,
        signature: sig, publicKey: wallet.publicKey,
        timestamp: ts,
        status: "pending",
      };
      setSt("broadcasting");
      const res = await Relay.pushTx(tx);
      if (!res.ok) { setErr(res.error || "Broadcast failed"); setSt("idle"); return; }
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

// 10. MINE HERO ────────────────────────────────────────────────────────────────
function MineHero({ blockInfo, onLaunch }: any) {
  const m = Math.floor(blockInfo.remaining / 60);
  const s = blockInfo.remaining % 60;
  const time = m > 0 ? `${m}m ${s}s` : `${s}s`;
  return (
    <div className="relative overflow-hidden rounded-3xl glass-hi px-6 py-12 sm:py-16 text-center">
      {/* Soft halo */}
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[480px] h-[480px] rounded-full bg-primary/10 blur-3xl" />
      <div className="relative">
        <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight mb-3">
          <span className="text-foreground">MINE </span>
          <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">$BLOB</span>
        </h1>
        <div className="text-xs sm:text-sm text-muted-foreground mb-8 num">
          Block #{blockInfo.height} · Reward: {blockInfo.reward} $BLOB · Level seed #{blockInfo.seed}
        </div>
        <div className="text-4xl sm:text-5xl font-light text-primary/90 mb-6 num">
          {time} remaining
        </div>
        <div className="inline-flex items-center gap-3 px-5 py-2 rounded-full border border-border/50 bg-card/40 text-[10px] sm:text-xs tracking-[0.18em] text-muted-foreground uppercase mb-3 num">
          <span>Space / Jump</span>
          <span className="text-border">·</span>
          <span>↓ Duck</span>
          <span className="text-border">·</span>
          <span>Ƀ +50 Pts</span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 mb-8">
          Higher score = higher probability of winning block reward
        </div>
        <button
          onClick={onLaunch}
          className="group relative inline-flex items-center gap-2 px-10 py-4 rounded-full bg-primary/10 border border-primary/40 text-primary font-semibold tracking-wide text-sm sm:text-base hover:bg-primary/20 transition-all shadow-[0_0_40px_hsl(var(--primary)/0.35)] hover:shadow-[0_0_60px_hsl(var(--primary)/0.55)]"
        >
          <Play className="w-4 h-4 fill-primary" />
          LAUNCH BLOB RUN
        </button>
      </div>
    </div>
  );
}

// 11. MINING PANEL ─────────────────────────────────────────────────────────────
function MiningPanel({ blockInfo, entries, myEntry, chain }: any) {
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const total = entries.reduce((s: number, e: any) => s + e.score, 0);
  const supplyNow = calcTotalSupply(chain);
  const supplyPct = Math.min((supplyNow / MAX_SUPPLY) * 100, 100);

  const Stat = ({ label, value, accent }: any) => (
    <div className="px-1">
      <div className="label-eyebrow mb-2">{label}</div>
      <div className={`text-2xl sm:text-3xl font-semibold num ${accent || "text-foreground"}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-1">
        <Stat label="Block" value={`#${blockInfo.height}`} accent="text-primary" />
        <Stat label="Reward" value={`${blockInfo.reward} $BLOB`} />
        <Stat label="Remaining" value={`${blockInfo.remaining}s`} accent="text-primary" />
        <Stat label="Miners" value={entries.length} />
      </div>

      <div className="glass px-5 py-4">
        <div className="flex items-center justify-between mb-3 text-xs">
          <span className="font-medium tracking-wide">$BLOB SUPPLY</span>
          <span className="text-muted-foreground num">
            {supplyNow.toFixed(2)} / {MAX_SUPPLY.toLocaleString()} ({supplyPct.toFixed(5)}%)
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-500 shadow-[0_0_12px_hsl(var(--primary)/0.6)]"
            style={{ width: `${supplyPct}%` }}
          />
        </div>
      </div>

      <div>
        {entries.length === 0 ? (
          <div className="relative glass overflow-hidden">
            <div className="px-6 py-10 sm:py-14 flex items-center min-h-[160px]">
              <div className="text-base sm:text-lg text-foreground/80 max-w-[60%] leading-relaxed">
                No entries yet — play Blob Run to submit yours
              </div>
            </div>
            <img
              src={runnerArt}
              alt=""
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-40 sm:w-48 opacity-70"
              loading="lazy"
              width={512}
              height={512}
            />
          </div>
        ) : (
          <>
            <div className="label-eyebrow mb-3 px-1">Current block entries</div>
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
            {myEntry && (
              <div className="mt-3 text-xs text-center text-muted-foreground">
                Your win probability: <span className="text-primary num">{winProbability(myEntry.score, entries)}%</span>
                {" · weighted random lottery"}
              </div>
            )}
          </>
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

// 13. WALLET SCREEN — clean layout matching the Mine tab ──────────────────────
function WalletScreen({ wallet, chain, mempool, onBroadcast }: any) {
  const [copied, setCopied] = useState(false);
  const balance = calcBalance(wallet.address, chain);
  const pending = mempool
    .filter((tx: any) => tx.to === wallet.address)
    .reduce((s: number, tx: any) => s + tx.amount, 0);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // Build transaction history: confirmed (chain) + pending (mempool) + block rewards
  const history = (() => {
    const items: any[] = [];
    for (const b of chain) {
      if (b.winner === wallet.address && (b.reward || 0) > 0) {
        items.push({
          kind: "reward",
          amount: b.reward,
          counterparty: `Block #${b.height}`,
          ts: b.timestamp,
          status: "confirmed",
          id: `r-${b.height}`,
        });
      }
      for (const tx of (b.transactions || [])) {
        if (tx.to === wallet.address || tx.from === wallet.address) {
          items.push({
            kind: tx.from === wallet.address ? "send" : "receive",
            amount: tx.amount,
            fee: tx.fee || TX_FEE,
            counterparty: tx.from === wallet.address ? tx.to : (tx.fromUsername || tx.from),
            ts: tx.timestamp,
            status: "confirmed",
            id: tx.id,
          });
        }
      }
    }
    for (const tx of mempool) {
      if (tx.to === wallet.address || tx.from === wallet.address) {
        items.push({
          kind: tx.from === wallet.address ? "send" : "receive",
          amount: tx.amount,
          fee: tx.fee || TX_FEE,
          counterparty: tx.from === wallet.address ? tx.to : (tx.fromUsername || tx.from),
          ts: tx.timestamp,
          status: "pending",
          id: tx.id,
        });
      }
    }
    return items.sort((a, b) => b.ts - a.ts);
  })();

  const Stat = ({ label, value, accent }: any) => (
    <div className="px-1">
      <div className="label-eyebrow mb-2">{label}</div>
      <div className={`text-2xl sm:text-3xl font-semibold num ${accent || "text-foreground"}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Hero balance + address */}
      <div className="relative overflow-hidden rounded-3xl glass-hi px-5 sm:px-8 py-8 sm:py-10">
        <div className="pointer-events-none absolute -top-32 right-0 w-[420px] h-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <div className="label-eyebrow mb-2">Balance</div>
              <div className="num text-4xl sm:text-6xl font-semibold leading-none text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)]">
                {balance.toFixed(6)}
                <span className="text-base sm:text-lg text-muted-foreground ml-2 font-normal">$BLOB</span>
              </div>
              {pending > 0 && (
                <div className="text-xs text-muted-foreground num mt-2">+{pending.toFixed(6)} incoming</div>
              )}
            </div>
            <div className="flex items-center gap-2 max-w-full">
              <div className="flex items-center gap-2 px-3 py-2 rounded-full border border-border bg-card/50 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))] shrink-0" />
                <span className="num text-xs text-foreground/80 truncate">{wallet.address}</span>
              </div>
              <button
                onClick={copy}
                className="px-3 py-2 rounded-full text-xs border border-border hover:border-primary/40 hover:text-primary transition shrink-0"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Stats row — match Mine tab style */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-1">
        <Stat label="Available" value={balance.toFixed(2)} accent="text-primary" />
        <Stat label="Pending" value={pending.toFixed(2)} />
        <Stat label="Sent" value={history.filter(h => h.kind === "send").length} />
        <Stat label="Received" value={history.filter(h => h.kind !== "send").length} />
      </div>

      {/* Send + History */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 order-1 lg:order-2">
          <div className="glass-hi p-5 sm:p-6 lg:sticky lg:top-20">
            <div className="label-eyebrow mb-4">Send $BLOB</div>
            <SendTxForm wallet={wallet} chain={chain} onBroadcast={onBroadcast} />
          </div>
        </div>

        <div className="lg:col-span-2 order-2 lg:order-1 space-y-2">
          <div className="label-eyebrow px-1">Transaction history</div>
          {history.length === 0 ? (
            <div className="glass px-5 py-10 text-center text-sm text-muted-foreground">
              No transactions yet — mine a block or send some $BLOB to see history here
            </div>
          ) : (
            <div className="space-y-1.5">
              {history.map((h) => {
                const isOut = h.kind === "send";
                const isReward = h.kind === "reward";
                const Icon = isReward ? Trophy : isOut ? ArrowUpRight : ArrowDownLeft;
                const color = isReward
                  ? "text-[hsl(var(--warning))]"
                  : isOut
                    ? "text-destructive"
                    : "text-primary";
                const sign = isOut ? "−" : "+";
                return (
                  <div key={h.id} className="glass px-4 py-3 flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full border border-border bg-card/50 flex items-center justify-center ${color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">
                          {isReward ? "Block reward" : isOut ? "Sent" : "Received"}
                        </span>
                        {h.status === "pending" && (
                          <span className="text-[10px] tracking-wide uppercase px-1.5 py-0.5 rounded-full border border-border text-muted-foreground">
                            Pending
                          </span>
                        )}
                      </div>
                      <div className="num text-xs text-muted-foreground truncate">
                        {isReward ? h.counterparty : (isOut ? "to " : "from ") + h.counterparty}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`num text-sm font-semibold ${color}`}>
                        {sign}{Number(h.amount).toFixed(4)}
                      </div>
                      <div className="num text-[10px] text-muted-foreground">
                        {new Date(h.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
  const [vaultPub, setVaultPub] = useState<Vault.WalletPublic | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPass, setUnlockPass] = useState("");
  const [unlockErr, setUnlockErr] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showPriv, setShowPriv] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMode, setConnectMode] = useState<"choose" | "create" | "import">("choose");
  const [nameIn, setNameIn] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [importJson, setImportJson] = useState("");
  const [connectErr, setConnectErr] = useState("");
  const [creating, setCreating] = useState(false);

  const [chain, setChain] = useState<any[]>([GENESIS]);
  const [mempool, setMempool] = useState<any[]>([]);
  const [entries, setEntries] = useState<any[]>([]);
  const [myEntry, setMyEntry] = useState<any>(null);
  const [blockInfo, setBlock] = useState(getBlockInfo());
  const [nodeCount] = useState(1);
  const [newBlock, setNewBlock] = useState<any>(null);
  const [screen, setScreen] = useState("mine");
  const [gameLaunched, setGameLaunched] = useState(false);

  useEffect(() => {
    // Force-purge any legacy plaintext wallet from previous versions of the app
    Vault.purgeLegacyPlaintextWallet();
    setVaultPub(Vault.getStoredWalletPublic());
    document.title = "⬡ BLOB CHAIN — Proof-of-Gaming";
  }, []);

  function resetConnect() {
    setConnectMode("choose");
    setNameIn("");
    setPass1("");
    setPass2("");
    setImportJson("");
    setConnectErr("");
  }

  async function createWallet() {
    if (!nameIn.trim()) return;
    if (pass1.length < 6) { setConnectErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setConnectErr("Passphrases do not match"); return; }
    setCreating(true);
    setConnectErr("");
    try {
      const w: any = await generateWallet();
      w.username = nameIn.trim().slice(0, 24);
      await Vault.saveEncryptedWallet(w, pass1);
      setVaultPub({ address: w.address, publicKey: w.publicKey, username: w.username });
      setWallet(w);
      setConnectOpen(false);
      resetConnect();
    } catch (e: any) {
      setConnectErr(String(e?.message || e));
    } finally {
      setCreating(false);
    }
  }

  async function importWallet() {
    setConnectErr("");
    if (!nameIn.trim()) { setConnectErr("Enter a miner name"); return; }
    if (pass1.length < 6) { setConnectErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setConnectErr("Passphrases do not match"); return; }
    let parsed: any;
    try { parsed = JSON.parse(importJson.trim()); }
    catch { setConnectErr("Invalid JSON"); return; }
    if (!parsed.address || !parsed.publicKey || !parsed.privateKey) {
      setConnectErr("Missing address / publicKey / privateKey");
      return;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(parsed.privateKey)) { setConnectErr("privateKey must be 64 hex chars"); return; }
    if (!/^[0-9a-fA-F]{66}$/.test(parsed.publicKey)) { setConnectErr("publicKey must be 66 hex chars (compressed)"); return; }
    try {
      const derived = pubKeyToAddress(parsed.publicKey.toLowerCase());
      if (derived !== parsed.address) { setConnectErr("address does not match publicKey"); return; }
    } catch { setConnectErr("Invalid public key"); return; }
    const w: any = {
      address: parsed.address,
      publicKey: parsed.publicKey.toLowerCase(),
      privateKey: parsed.privateKey.toLowerCase(),
      username: nameIn.trim().slice(0, 24),
    };
    try {
      await Vault.saveEncryptedWallet(w, pass1);
      setVaultPub({ address: w.address, publicKey: w.publicKey, username: w.username });
      setWallet(w);
      setConnectOpen(false);
      resetConnect();
    } catch (e: any) {
      setConnectErr(String(e?.message || e));
    }
  }

  async function unlockExisting() {
    setUnlockErr("");
    setUnlocking(true);
    try {
      const w = await Vault.unlockWallet(unlockPass);
      setWallet(w);
      setUnlockOpen(false);
      setUnlockPass("");
    } catch (e: any) {
      setUnlockErr(String(e?.message || e));
    } finally {
      setUnlocking(false);
    }
  }

  function disconnectWallet() {
    Vault.clearWallet();
    setWallet(null);
    setVaultPub(null);
    setGameLaunched(false);
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

  // Block sealing — server-side only. We just trigger seal-block for the
  // closed height; the realtime onBlock handler will deliver the new block.
  const prevHeightRef = useRef(blockInfo.height);
  useEffect(() => {
    const prevHeight = prevHeightRef.current;
    if (blockInfo.height === prevHeight) return;
    const closedHeight = blockInfo.height - 1;
    prevHeightRef.current = blockInfo.height;
    if (closedHeight < 1) return;

    (async () => {
      // Avoid hammering: only call seal if we don't already have it locally
      if (chainRef.current.find(b => b.height === closedHeight)) return;
      // Small jitter so multiple tabs don't all fire at the same instant
      await new Promise(r => setTimeout(r, Math.random() * 1500));
      if (chainRef.current.find(b => b.height === closedHeight)) return;
      await Relay.sealBlock(closedHeight);
      // Reset entries for the new round; the realtime feed will populate the new block
      setEntries([]);
      setMyEntry(null);
    })();
  }, [blockInfo.height]);

  const onEntrySubmit = useCallback(entry => {
    setMyEntry(entry);
    setEntries(e => e.find(x => x.address === entry.address) ? e.map(x => x.address === entry.address ? entry : x) : [...e, entry]);
  }, []);

  const onTxBroadcast = useCallback(tx => {
    setMempool(m => [...m, tx]);
  }, []);

  const balance = wallet ? calcBalance(wallet.address, chain) : 0;
  const nav = [
    { id: "mine", text: "Mine" },
    { id: "wallet", text: "Wallet" },
    { id: "mempool", text: "Mempool" },
    { id: "chain", text: "Explorer" },
    { id: "network", text: "Network" },
  ];

  const openConnect = () => {
    resetConnect();
    setConnectOpen(true);
  };

  const ConnectWalletDialog = (
    <Dialog open={connectOpen} onOpenChange={(o) => { setConnectOpen(o); if (!o) resetConnect(); }}>
      <DialogContent className="glass-hi border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium tracking-wide">
            {connectMode === "choose" ? "Connect wallet" : connectMode === "create" ? "Create new wallet" : "Import wallet"}
          </DialogTitle>
        </DialogHeader>

        {connectMode === "choose" && (
          <div className="space-y-3 pt-1">
            <button
              onClick={() => { setConnectErr(""); setConnectMode("create"); }}
              className="w-full glass hover:ring-1 hover:ring-primary/40 transition p-4 flex items-center gap-4 text-left"
            >
              <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                <Plus className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">Create new wallet</div>
                <div className="text-xs text-muted-foreground">Generate a fresh ECDSA P-256 keypair in your browser</div>
              </div>
            </button>
            <button
              onClick={() => { setConnectErr(""); setConnectMode("import"); }}
              className="w-full glass hover:ring-1 hover:ring-primary/40 transition p-4 flex items-center gap-4 text-left"
            >
              <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                <Download className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">Import wallet</div>
                <div className="text-xs text-muted-foreground">Restore from an exported wallet JSON</div>
              </div>
            </button>
            <div className="text-[11px] text-muted-foreground/70 text-center pt-1">
              Keys never leave your device · Stored only in this browser
            </div>
          </div>
        )}

        {connectMode === "create" && (
          <div className="space-y-3 pt-1">
            <div>
              <label className="label-eyebrow block mb-2">Miner name</label>
              <input
                value={nameIn}
                onChange={e => setNameIn(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !creating && createWallet()}
                placeholder="SatoshiBlob…"
                maxLength={24}
                autoFocus
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Passphrase</label>
              <input
                type="password"
                value={pass1}
                onChange={e => setPass1(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Confirm passphrase</label>
              <input
                type="password"
                value={pass2}
                onChange={e => setPass2(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !creating && createWallet()}
                placeholder="Repeat passphrase"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            {connectErr && <div className="text-xs text-destructive">{connectErr}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => setConnectMode("choose")}
                className="px-4 py-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition"
              >
                Back
              </button>
              <button
                onClick={createWallet}
                disabled={creating || !nameIn.trim() || !pass1 || !pass2}
                className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {creating ? "Generating keypair…" : "Generate wallet"}
              </button>
            </div>
            <div className="text-[11px] text-muted-foreground/70 text-center pt-1">
              secp256k1 keypair generated in your browser (Bitcoin curve)
            </div>
          </div>
        )}

        {connectMode === "import" && (
          <div className="space-y-3 pt-1">
            <div>
              <label className="label-eyebrow block mb-2">Miner name</label>
              <input
                value={nameIn}
                onChange={e => setNameIn(e.target.value)}
                placeholder="SatoshiBlob…"
                maxLength={24}
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Wallet JSON</label>
              <textarea
                value={importJson}
                onChange={e => setImportJson(e.target.value)}
                placeholder='{"address":"1…","publicKey":"02… (66 hex)","privateKey":"… (64 hex)"}'
                rows={5}
                className="num w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-[11px] leading-relaxed resize-none"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Passphrase</label>
              <input
                type="password"
                value={pass1}
                onChange={e => setPass1(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Confirm passphrase</label>
              <input
                type="password"
                value={pass2}
                onChange={e => setPass2(e.target.value)}
                placeholder="Repeat passphrase"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            {connectErr && <div className="text-xs text-destructive">{connectErr}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => setConnectMode("choose")}
                className="px-4 py-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition"
              >
                Back
              </button>
              <button
                onClick={importWallet}
                className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition"
              >
                Import wallet
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

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
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-4">
          <h1 className="text-base font-semibold tracking-[0.35em] text-primary drop-shadow-[0_0_12px_hsl(var(--primary)/0.4)]">
            BLOB
          </h1>

          <nav className="hidden sm:flex items-center gap-1">
            {nav.map(n => {
              const active = screen === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setScreen(n.id)}
                  className={`relative px-4 py-2 text-sm font-medium transition ${
                    active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {n.text}
                  {active && (
                    <span className="absolute left-3 right-3 -bottom-px h-px bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex flex-col items-center px-3 py-1 rounded-full border border-primary/30 bg-primary/5">
              <span className="text-[9px] tracking-widest text-primary/80 leading-none">NETWORK</span>
              <span className="num text-[11px] text-primary leading-tight">{blockInfo.remaining}s</span>
            </div>

            {wallet && (
              <Dialog>
                <DialogTrigger asChild>
                  <button
                    className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium border border-border hover:border-primary/40 hover:text-primary transition"
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
            )}

            {wallet ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 px-3 py-2 rounded-full border border-border hover:border-primary/40 transition text-xs group">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                    <span className="hidden md:inline text-muted-foreground max-w-[100px] truncate">{wallet.username}</span>
                    <span className="num text-primary">{balance.toFixed(2)}</span>
                    <ChevronDown className="w-3 h-3 text-muted-foreground group-hover:text-primary transition" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="glass-hi border-border w-56">
                  <DropdownMenuLabel className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                    Connected as
                  </DropdownMenuLabel>
                  <div className="px-2 pb-2">
                    <div className="text-sm font-medium truncate">{wallet.username}</div>
                    <div className="num text-[10px] text-muted-foreground truncate">{wallet.address}</div>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setScreen("wallet")} className="cursor-pointer">
                    <Wallet className="w-4 h-4 mr-2" /> Open wallet
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setShowPriv(false); setSettingsOpen(true); }} className="cursor-pointer">
                    <SettingsIcon className="w-4 h-4 mr-2" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={disconnectWallet}
                    className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <LogOut className="w-4 h-4 mr-2" /> Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : vaultPub ? (
              <button
                onClick={() => { setUnlockErr(""); setUnlockPass(""); setUnlockOpen(true); }}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground text-xs font-semibold tracking-wide hover:bg-primary/90 transition shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
              >
                <Lock className="w-3.5 h-3.5" />
                Unlock wallet
              </button>
            ) : (
              <button
                onClick={openConnect}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground text-xs font-semibold tracking-wide hover:bg-primary/90 transition shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
              >
                <Wallet className="w-3.5 h-3.5" />
                Connect wallet
              </button>
            )}
          </div>
        </div>

        {/* Mobile nav */}
        <nav className="sm:hidden flex items-center justify-around border-t border-border/60">
          {nav.map(n => {
            const active = screen === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setScreen(n.id)}
                className={`relative py-2.5 text-xs font-medium transition flex-1 ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {n.text}
                {active && (
                  <span className="absolute left-1/4 right-1/4 -bottom-px h-px bg-primary" />
                )}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 sm:py-8 relative z-10">
        {screen === "mine" && (
          <div className="space-y-6">
            {!wallet ? (
              <div className="relative overflow-hidden rounded-3xl glass-hi px-6 py-16 sm:py-20 text-center">
                <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[480px] h-[480px] rounded-full bg-primary/10 blur-3xl" />
                <div className="relative">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 border border-primary/30 text-primary mb-5">
                    <Lock className="w-5 h-5" />
                  </div>
                  <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight mb-3">
                    <span className="text-foreground">Connect to mine </span>
                    <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">$BLOB</span>
                  </h1>
                  <div className="text-sm text-muted-foreground mb-8 max-w-md mx-auto leading-relaxed">
                    Blob Run requires a wallet to sign your score and receive block rewards.
                  </div>
                  <button
                    onClick={openConnect}
                    className="inline-flex items-center gap-2 px-8 py-4 rounded-full bg-primary text-primary-foreground font-semibold text-sm tracking-wide hover:bg-primary/90 transition shadow-[0_0_40px_hsl(var(--primary)/0.4)]"
                  >
                    <Wallet className="w-4 h-4" />
                    Connect wallet
                  </button>
                </div>
              </div>
            ) : !gameLaunched ? (
              <MineHero blockInfo={blockInfo} onLaunch={() => setGameLaunched(true)} />
            ) : (
              <BlobRunGame wallet={wallet} blockInfo={blockInfo} onEntrySubmit={onEntrySubmit} myEntry={myEntry} />
            )}
            <MiningPanel blockInfo={blockInfo} entries={entries} myEntry={myEntry} chain={chain} />
          </div>
        )}
        {screen === "wallet" && (
          wallet ? (
            <WalletScreen wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />
          ) : (
            <div className="glass-hi p-10 text-center space-y-4">
              <div className="text-sm text-muted-foreground">No wallet connected</div>
              <button
                onClick={openConnect}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition"
              >
                <Wallet className="w-4 h-4" />
                Connect wallet
              </button>
            </div>
          )
        )}
        {screen === "mempool" && <Mempool mempool={mempool} wallet={wallet || { address: "" }} />}
        {screen === "chain" && <BlockExplorer chain={chain} blockInfo={blockInfo} />}
        {screen === "network" && <NetworkView nodeCount={nodeCount} chain={chain} blockInfo={blockInfo} />}
      </main>

      {ConnectWalletDialog}

      <Dialog open={unlockOpen} onOpenChange={(o) => { setUnlockOpen(o); if (!o) { setUnlockPass(""); setUnlockErr(""); } }}>
        <DialogContent className="glass-hi border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium tracking-wide">Unlock wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div className="text-xs text-muted-foreground">
              {vaultPub?.username ? <>Welcome back, <span className="text-foreground">{vaultPub.username}</span></> : "Enter your passphrase to decrypt your wallet"}
            </div>
            <input
              type="password"
              value={unlockPass}
              onChange={e => setUnlockPass(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !unlocking && unlockExisting()}
              placeholder="Passphrase"
              autoFocus
              className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
            />
            {unlockErr && <div className="text-xs text-destructive">{unlockErr}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => { disconnectWallet(); setUnlockOpen(false); }}
                className="px-4 py-3 rounded-lg border border-destructive/30 text-xs text-destructive hover:bg-destructive/10 transition"
              >
                Forget wallet
              </button>
              <button
                onClick={unlockExisting}
                disabled={unlocking || !unlockPass}
                className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {unlocking ? "Decrypting…" : "Unlock"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <footer className="fixed bottom-0 left-0 right-0 backdrop-blur-xl bg-background/70 border-t border-border px-5 py-2 flex justify-between items-center text-[10px] text-muted-foreground/70 num">
        <span className="hidden sm:inline">⬡ BLOB CHAIN · Proof-of-Gaming</span>
        <span>Block #{blockInfo.height} · {blockInfo.remaining}s</span>
        <span>{chain.length - 1} blocks · {calcTotalSupply(chain).toFixed(2)} / {MAX_SUPPLY.toLocaleString()}</span>
      </footer>
    </div>
  );
}
