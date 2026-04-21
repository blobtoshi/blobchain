// @ts-nocheck
// ═══════════════════════════════════════════════════════════════════════════════
// ⬡ BLOB CHAIN — Proof-of-Gaming Blockchain (single-node local build)
// Bitcoin clone: $BLOB token, 0 starting supply, gameplay-mined
// Real ECDSA wallet · SHA-256 block hashing · Weighted lottery consensus
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as Relay from "@/lib/blobRelay";
import { supabase } from "@/integrations/supabase/client";
import * as Vault from "@/lib/walletVault";
import * as secp from "@noble/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { base58check } from "@scure/base";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Send, Play, Wallet, Plus, Download, Lock, Settings as SettingsIcon, LogOut, ChevronDown, ArrowDownLeft, ArrowUpRight, Trophy, Eye, EyeOff, Search, SlidersHorizontal, X, Zap, ArrowLeftRight, ExternalLink, Loader2, CheckCircle2, AlertCircle, Copy } from "lucide-react";
import runnerArt from "@/assets/blob-sprite.png";
import blobSprite from "@/assets/blob-sprite.png";

// 1. CONFIG ────────────────────────────────────────────────────────────────────
const BLOCK_TIME = 120;
const INITIAL_REWARD = 10;
const HALVING_BLOCKS = 1_000_000;   // halves every 1M blocks
const MAX_SUPPLY = 20_000_000;       // 10 × 1M × Σ(1/2^n) = 20M $BLOB
const MAX_BLOCK_SIZE = 1_000_000;   // ~1 MB, Bitcoin-style
const MAX_TX_SIZE = 100_000;        // ~100 KB, Bitcoin standard tx limit
const TX_FEE = 0.001;                // legacy fallback for old chain entries
const BLOB_DECIMALS = 8;             // $BLOB is divisible to 8 decimal places
const BLOB_UNIT = 1e8;               // 1 $BLOB = 100,000,000 drops (base unit)
const BASE_FEE_RATE = 10;            // drops/byte at zero congestion
const MIN_FEE_RATE = 1;              // absolute floor (drops/byte)
const MAX_MEMO_BYTES = 80;           // OP_RETURN-style memo limit
// Round a $BLOB amount to 8-decimal precision (banker-safe via integer base units).
const to8 = (n: number) => Math.round(Number(n) * BLOB_UNIT) / BLOB_UNIT;
// Canonical tx bytes — must match the server. fee is derived, not part of canon.
function canonicalTxBytes(tx: {
  from: string; to: string; amount: number; timestamp: number;
  feeRate: number; memo: string; publicKey: string; signature: string;
}): number {
  const canonical = JSON.stringify({
    from: tx.from, to: tx.to, amount: tx.amount, timestamp: tx.timestamp,
    feeRate: tx.feeRate, memo: tx.memo, publicKey: tx.publicKey, signature: tx.signature,
  });
  return new TextEncoder().encode(canonical).length;
}
const memoBytes = (m: string) => new TextEncoder().encode(m).length;
// Estimate fee for the UI (signature is 128 hex chars; pubkey 66; address ~34).
// Yields a stable byte count so the displayed fee matches what the server charges.
function estimateTxBytes(from: string, to: string, amount: number, ts: number, feeRate: number, memo: string) {
  const fakeSig = "00".repeat(64);
  const fakePub = "02" + "00".repeat(32);
  return canonicalTxBytes({
    from, to, amount, timestamp: ts, feeRate, memo,
    publicKey: fakePub, signature: fakeSig,
  });
}
const feeFromRate = (feeRate: number, bytes: number) => Math.ceil(feeRate * bytes) / BLOB_UNIT;

const SB_URL: string | undefined = (import.meta as any)?.env?.VITE_SUPABASE_URL;
const SB_KEY: string | undefined = (import.meta as any)?.env?.VITE_SUPABASE_ANON_KEY;
const GENESIS_TIME_MS = 1776731760000;

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

function calcBalance(address, chain, mempool?: any[]) {
  let bal = 0;
  for (const block of chain) {
    if (block.winner === address) bal += (block.reward || 0);
    for (const tx of (block.transactions || [])) {
      if (tx.to === address) bal += tx.amount;
      if (tx.from === address) bal -= (tx.amount + (tx.fee || TX_FEE));
    }
  }
  // Subtract pending outgoing transactions still sitting in the mempool
  // so the UI reflects spendable balance immediately after sending.
  if (mempool && mempool.length) {
    for (const tx of mempool) {
      if (tx.from === address) bal -= (tx.amount + (tx.fee || TX_FEE));
    }
  }
  return to8(Math.max(0, bal));
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

// Sprite image for the player blob — loaded once at module init.
const _blobImg: HTMLImageElement | null = (() => {
  if (typeof window === "undefined") return null;
  const img = new Image();
  img.src = blobSprite;
  return img;
})();

function drawBlob(ctx, x, y, action, wob, sq, _blink) {
  const duck = action === "duck";
  const baseW = duck ? 78 : 64;
  const baseH = duck ? 46 : 72;
  // Floating motion — gentle vertical bob + subtle horizontal sway
  const t = wob * 0.08;
  const floatY = duck ? 0 : Math.sin(t) * 5;
  const floatX = duck ? 0 : Math.sin(t * 0.7) * 1.5;
  ctx.save();
  ctx.translate(x + floatX, y + floatY - (duck ? 0 : 4));
  ctx.scale(1, sq);

  // Tiny shadow on the ground beneath the floating sprite
  if (!duck) {
    ctx.save();
    ctx.fillStyle = `rgba(0, 0, 0, ${0.25 - Math.abs(floatY) * 0.015})`;
    ctx.beginPath();
    ctx.ellipse(0, baseH * 0.55 + 6, baseW * 0.32, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  if (_blobImg && _blobImg.complete && _blobImg.naturalWidth > 0) {
    ctx.imageSmoothingEnabled = false; // keep pixel-art crispness
    ctx.drawImage(_blobImg, -baseW / 2, -baseH / 2, baseW, baseH);
  } else {
    ctx.fillStyle = "#3eecbf";
    ctx.beginPath();
    ctx.ellipse(0, 0, baseW * 0.4, baseH * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
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
      // Motion trail — fading after-images of the sprite following behind
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
function SendTxForm({ wallet, chain, mempool, onBroadcast, onSent }: any) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [memo, setMemo] = useState("");
  const [st, setSt] = useState("idle");
  const [err, setErr] = useState("");
  const [resolved, setResolved] = useState<{ address: string; username?: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  // Gas preset: 'slow' = 0.5×, 'normal' = 1×, 'fast' = 2×, 'custom' = manual
  const [preset, setPreset] = useState<"slow" | "normal" | "fast" | "custom">("normal");
  const [customRate, setCustomRate] = useState<string>("");
  const balance = calcBalance(wallet.address, chain, mempool);

  const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
  const USER_RE = /^[A-Za-z0-9_]{3,24}$/;

  // Fetch network fee info on mount, then refresh every 20s while the form is open.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const info = await Relay.fetchFeeInfo();
      if (!cancelled && info) setFeeInfo(info);
    };
    load();
    const id = setInterval(load, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;
  const presetRates = useMemo(() => ({
    slow: Math.max(MIN_FEE_RATE, Math.floor(recRate * 0.5)),
    normal: Math.max(MIN_FEE_RATE, recRate),
    fast: Math.max(MIN_FEE_RATE, Math.ceil(recRate * 2)),
  }), [recRate]);

  const activeFeeRate = preset === "custom"
    ? Math.max(MIN_FEE_RATE, Math.floor(Number(customRate) || 0))
    : presetRates[preset];

  // Live recipient resolution: username → address (case-insensitive),
  // or pass-through if the user typed a valid address.
  useEffect(() => {
    setErr("");
    const raw = to.trim().replace(/^@/, "");
    if (!raw) { setResolved(null); return; }
    if (ADDR_RE.test(raw)) {
      setResolved({ address: raw });
      return;
    }
    if (!USER_RE.test(raw)) {
      setResolved(null);
      return;
    }
    let cancelled = false;
    setResolving(true);
    (async () => {
      const { data, error } = await supabase.rpc("resolve_username", { p_username: raw });
      if (cancelled) return;
      setResolving(false);
      const row = (data as any[])?.[0];
      if (error || !row) { setResolved(null); return; }
      setResolved({ address: row.address, username: row.username });
    })();
    return () => { cancelled = true; };
  }, [to]);

  // Live fee preview (matches what the server will charge).
  const parsedAmt = (() => { const n = parseFloat(amt); return Number.isFinite(n) && n > 0 ? to8(n) : 0; })();
  const previewToAddress = resolved?.address || (ADDR_RE.test(to.trim().replace(/^@/, "")) ? to.trim().replace(/^@/, "") : "");
  const memoLen = memoBytes(memo);
  const memoOver = memoLen > MAX_MEMO_BYTES;
  const previewBytes = previewToAddress && parsedAmt > 0 && activeFeeRate >= MIN_FEE_RATE && !memoOver
    ? estimateTxBytes(wallet.address, previewToAddress, parsedAmt, Date.now(), activeFeeRate, memo)
    : 0;
  const previewFee = previewBytes ? feeFromRate(activeFeeRate, previewBytes) : 0;
  const previewTotal = parsedAmt + previewFee;

  async function send() {
    setErr("");
    const parsed = parseFloat(amt);
    const raw = to.trim().replace(/^@/, "");
    if (!raw) { setErr("Enter a recipient (address or @username)"); return; }
    let toAddress = "";
    if (ADDR_RE.test(raw)) toAddress = raw;
    else if (resolved?.address) toAddress = resolved.address;
    else { setErr("Recipient not found"); return; }
    if (toAddress === wallet.address) { setErr("Cannot send to yourself"); return; }
    if (!Number.isFinite(parsed) || parsed <= 0) { setErr("Invalid amount"); return; }
    const amount = to8(parsed);
    if (amount <= 0) { setErr(`Minimum amount is ${(1 / BLOB_UNIT).toFixed(BLOB_DECIMALS)} $BLOB`); return; }
    if (memoOver) { setErr(`Memo too long (${memoLen}/${MAX_MEMO_BYTES} bytes)`); return; }
    if (!Number.isFinite(activeFeeRate) || activeFeeRate < MIN_FEE_RATE) {
      setErr(`Fee rate must be at least ${MIN_FEE_RATE} drops/byte`); return;
    }
    setSt("signing");
    try {
      const ts = Date.now();
      const txid = await sha256hex(`${wallet.address}${toAddress}${amount}${ts}${activeFeeRate}${memo}`);
      // Sign payload v2 — must match server: from→to:amount@ts|fr=feeRate|m=memo
      const data = `${wallet.address}→${toAddress}:${amount}@${ts}|fr=${activeFeeRate}|m=${memo}`;
      const sig = await signData(wallet.privateKey, data);
      const bytes = canonicalTxBytes({
        from: wallet.address, to: toAddress, amount, timestamp: ts,
        feeRate: activeFeeRate, memo, publicKey: wallet.publicKey, signature: sig,
      });
      const fee = feeFromRate(activeFeeRate, bytes);
      if (amount + fee > balance) {
        setErr(`Insufficient balance (need ${(amount + fee).toFixed(BLOB_DECIMALS)})`);
        setSt("idle"); return;
      }
      const tx = {
        id: txid.slice(0, 40),
        from: wallet.address, fromUsername: wallet.username,
        to: toAddress, amount, fee,
        feeRate: activeFeeRate, memo,
        signature: sig, publicKey: wallet.publicKey,
        timestamp: ts,
        status: "pending",
      };
      setSt("broadcasting");
      const res = await Relay.pushTx(tx);
      if (!res.ok) { setErr(res.error || "Broadcast failed"); setSt("idle"); return; }
      onBroadcast(tx);
      setSt("sent"); setTo(""); setAmt(""); setMemo(""); setResolved(null);
      setTimeout(() => { setSt("idle"); onSent?.(); }, 1500);
    } catch (e) { setErr(String(e)); setSt("idle"); }
  }

  const disabled = st !== "idle";
  const label = st === "idle" ? "Broadcast transaction"
              : st === "signing" ? "Signing…"
              : st === "broadcasting" ? "Broadcasting…"
              : "✓ Sent";

  const trimmed = to.trim().replace(/^@/, "");
  const looksLikeUser = trimmed && !ADDR_RE.test(trimmed) && USER_RE.test(trimmed);
  const looksLikeAddr = trimmed && ADDR_RE.test(trimmed);
  const unknownInput = trimmed && !looksLikeUser && !looksLikeAddr;

  const PresetButton = ({ id, title, sub }: { id: "slow" | "normal" | "fast"; title: string; sub: string }) => {
    const active = preset === id;
    return (
      <button
        type="button"
        onClick={() => setPreset(id)}
        className={`flex flex-col items-start px-3 py-2 rounded-lg border text-left transition ${
          active
            ? "border-primary/70 bg-primary/10 text-primary"
            : "border-border bg-secondary/40 text-foreground hover:border-primary/40"
        }`}
      >
        <span className="text-[11px] font-medium tracking-wide">{title}</span>
        <span className="text-[10px] text-muted-foreground num mt-0.5">{sub}</span>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Available</span>
        <span className="num text-primary">{balance.toFixed(BLOB_DECIMALS)} $BLOB</span>
      </div>
      <div className="space-y-2">
        <label className="label-eyebrow block">Recipient</label>
        <input
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="@username or address"
          className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num placeholder:text-muted-foreground/60 placeholder:font-sans"
        />
        {trimmed && (
          <div className="text-[11px] min-h-[14px]">
            {resolving && <span className="text-muted-foreground">Resolving…</span>}
            {!resolving && looksLikeUser && resolved && (
              <span className="text-primary/80">
                ✓ @{resolved.username} → <span className="num text-muted-foreground">{resolved.address.slice(0, 14)}…{resolved.address.slice(-6)}</span>
              </span>
            )}
            {!resolving && looksLikeUser && !resolved && (
              <span className="text-destructive">Username not registered</span>
            )}
            {!resolving && looksLikeAddr && (
              <span className="text-muted-foreground">Sending to address</span>
            )}
            {unknownInput && (
              <span className="text-destructive">Not a valid address or username</span>
            )}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <label className="label-eyebrow block">Amount</label>
        <div className="relative">
          <input
            value={amt}
            onChange={e => setAmt(e.target.value)}
            type="number"
            min="0"
            step="0.00000001"
            placeholder="0.00000000"
            className="w-full px-4 py-3 pr-20 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num placeholder:text-muted-foreground/60"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$BLOB</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label-eyebrow block">Memo <span className="text-muted-foreground/60">(optional)</span></label>
          <span className={`text-[10px] num ${memoOver ? "text-destructive" : "text-muted-foreground"}`}>
            {memoLen}/{MAX_MEMO_BYTES}B
          </span>
        </div>
        <input
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder="Note attached on-chain (e.g. invoice #1234)"
          className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm placeholder:text-muted-foreground/60"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label-eyebrow block">Gas (network fee)</label>
          <span className="text-[10px] text-muted-foreground num">
            recommended <span className="text-primary">{recRate}</span> drops/B
          </span>
        </div>
        <Select
          value={preset}
          onValueChange={(v) => setPreset(v as "slow" | "normal" | "fast" | "custom")}
        >
          <SelectTrigger className="w-full h-10 bg-secondary/60 border-border focus:border-primary/60">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-primary" />
              <SelectValue placeholder="Select gas preset" />
            </div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="slow" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Slow</span>
                <span className="text-[10px] text-muted-foreground num">{presetRates.slow} drops/B · ~10 min</span>
              </div>
            </SelectItem>
            <SelectItem value="normal" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Normal</span>
                <span className="text-[10px] text-muted-foreground num">{presetRates.normal} drops/B · ~5 min</span>
              </div>
            </SelectItem>
            <SelectItem value="fast" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Fast</span>
                <span className="text-[10px] text-muted-foreground num">{presetRates.fast} drops/B · ~2 min</span>
              </div>
            </SelectItem>
            <SelectItem value="custom" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Custom</span>
                <span className="text-[10px] text-muted-foreground num">Set your own rate</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>

        {preset === "custom" && (
          <div className="relative">
            <input
              value={customRate}
              onChange={e => setCustomRate(e.target.value)}
              type="number"
              min={MIN_FEE_RATE}
              step="1"
              placeholder={String(recRate)}
              className="w-full px-3 py-2 pr-16 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">drops/B</span>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border/60 bg-secondary/30 px-3 py-2 text-xs space-y-1">
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Fee rate</span>
          <span className="num">{activeFeeRate} drops/B</span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Tx size (est.)</span>
          <span className="num">{previewBytes || "—"} B</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Network fee</span>
          <span className="num text-foreground">{previewFee.toFixed(BLOB_DECIMALS)} $BLOB</span>
        </div>
        <div className="flex items-center justify-between border-t border-border/60 pt-1 mt-1">
          <span className="text-muted-foreground">Total</span>
          <span className="num text-primary">{previewTotal.toFixed(BLOB_DECIMALS)} $BLOB</span>
        </div>
      </div>

      {err && <div className="text-xs text-destructive">{err}</div>}
      {st === "sent" && <div className="text-xs text-primary">✓ Broadcast to mempool</div>}
      <button
        onClick={send}
        disabled={disabled || memoOver}
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

// 11. EXPLORER ────────────────────────────────────────────────────────────────
// A full-featured blockchain explorer (overview / blocks / txs / mempool /
// addresses) with a global search bar — inspired by Etherscan / Solscan but
// styled to match the rest of the app's glass + warning-accent aesthetic.

type ExplorerTx = {
  id: string;
  from: string;
  to: string;
  fromUsername?: string;
  toUsername?: string;
  amount: number;
  fee: number;
  feeRate?: number;
  memo?: string;
  timestamp: number;
  status: "confirmed" | "pending";
  block?: number;
  signature?: string;
  kind: "transfer" | "reward";
};

function flattenChainTxs(chain: any[]): ExplorerTx[] {
  const out: ExplorerTx[] = [];
  for (const b of chain) {
    if (b.winner && b.reward > 0) {
      out.push({
        id: `reward-${b.height}`,
        from: "coinbase",
        to: b.winner,
        toUsername: b.winnerUsername,
        amount: Number(b.reward),
        fee: 0,
        timestamp: b.timestamp,
        status: "confirmed",
        block: b.height,
        kind: "reward",
      });
    }
    for (const tx of (b.transactions || [])) {
      out.push({
        id: tx.id || `${b.height}-${tx.signature?.slice(0, 12)}`,
        from: tx.from,
        to: tx.to,
        fromUsername: tx.fromUsername,
        toUsername: tx.toUsername,
        amount: Number(tx.amount),
        fee: Number(tx.fee || 0),
        feeRate: tx.feeRate != null ? Number(tx.feeRate) : undefined,
        memo: tx.memo || "",
        timestamp: tx.timestamp || b.timestamp,
        status: "confirmed",
        block: b.height,
        signature: tx.signature,
        kind: "transfer",
      });
    }
  }
  // newest first
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

function mempoolToTxs(mempool: any[]): ExplorerTx[] {
  return mempool.map((tx: any) => ({
    id: tx.id,
    from: tx.from,
    to: tx.to,
    fromUsername: tx.fromUsername,
    amount: Number(tx.amount),
    fee: Number(tx.fee || 0),
    feeRate: tx.feeRate != null ? Number(tx.feeRate) : undefined,
    memo: tx.memo || "",
    timestamp: tx.timestamp,
    status: "pending" as const,
    signature: tx.signature,
    kind: "transfer" as const,
  }));
}

function shortHash(s?: string, n = 8) {
  if (!s) return "—";
  if (s.length <= n * 2 + 1) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function ExplorerStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="glass px-4 py-3">
      <div className="label-eyebrow mb-1.5">{label}</div>
      <div className="text-base font-medium num text-foreground/90">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground num mt-0.5">{sub}</div>}
    </div>
  );
}

function ExplorerTabBtn({ active, onClick, children, count }: any) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium tracking-wide transition border-b ${
        active
          ? "text-[hsl(var(--warning))] border-[hsl(var(--warning))]"
          : "text-muted-foreground border-transparent hover:text-foreground/80"
      }`}
    >
      {children}
      {typeof count === "number" && (
        <span className="ml-1.5 num text-[10px] text-muted-foreground">({count})</span>
      )}
    </button>
  );
}

const PAGE_SIZE = 100;

function Pager({ page, setPage, total, label }: { page: number; setPage: (n: number) => void; total: number; label: string }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, total);
  return (
    <div className="glass flex items-center justify-between px-3 py-2 text-xs">
      <span className="text-muted-foreground num">{start}–{end} of {total} {label}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => setPage(0)} disabled={page === 0}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">«</button>
        <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">‹</button>
        <span className="num text-muted-foreground px-2">page {page + 1} / {pages}</span>
        <button onClick={() => setPage(Math.min(pages - 1, page + 1))} disabled={page >= pages - 1}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">›</button>
        <button onClick={() => setPage(pages - 1)} disabled={page >= pages - 1}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">»</button>
      </div>
    </div>
  );
}

// ---------- Explorer filters ----------
type TxFilters = {
  addr: string;
  addrSide: "any" | "from" | "to";
  minAmount: string;
  maxAmount: string;
  dateFrom: string;
  dateTo: string;
  status: "all" | "confirmed" | "pending";
  kind: "all" | "transfer" | "reward";
  sort: "newest" | "oldest" | "amount-desc" | "amount-asc";
};
const emptyTxFilters: TxFilters = {
  addr: "", addrSide: "any", minAmount: "", maxAmount: "",
  dateFrom: "", dateTo: "", status: "all", kind: "all", sort: "newest",
};

type BlockFilters = {
  winner: string;
  minHeight: string;
  maxHeight: string;
  dateFrom: string;
  dateTo: string;
  hasTxs: "all" | "yes" | "no";
  sort: "newest" | "oldest" | "reward-desc" | "score-desc";
};
const emptyBlockFilters: BlockFilters = {
  winner: "", minHeight: "", maxHeight: "", dateFrom: "", dateTo: "", hasTxs: "all", sort: "newest",
};

type AddrFilters = {
  q: string;
  minBalance: string;
  hasMined: "all" | "yes" | "no";
  hasTxs: "all" | "yes" | "no";
  sort: "balance-desc" | "balance-asc" | "mined-desc" | "tx-desc" | "recent" | "username";
};
const emptyAddrFilters: AddrFilters = {
  q: "", minBalance: "", hasMined: "all", hasTxs: "all", sort: "balance-desc",
};

function dateToTs(d: string, end = false): number | null {
  if (!d) return null;
  const t = new Date(d + (end ? "T23:59:59.999" : "T00:00:00")).getTime();
  return Number.isFinite(t) ? t : null;
}
function applyTxFilters(list: ExplorerTx[], f: TxFilters): ExplorerTx[] {
  const addr = f.addr.trim().toLowerCase();
  const min = f.minAmount === "" ? null : Number(f.minAmount);
  const max = f.maxAmount === "" ? null : Number(f.maxAmount);
  const from = dateToTs(f.dateFrom);
  const to = dateToTs(f.dateTo, true);
  const matchAddr = (val?: string, uname?: string) =>
    !!val && (val.toLowerCase().includes(addr) || (uname || "").toLowerCase().includes(addr));
  const out = list.filter(t => {
    if (f.kind !== "all" && t.kind !== f.kind) return false;
    if (f.status !== "all" && t.status !== f.status) return false;
    if (min !== null && t.amount < min) return false;
    if (max !== null && t.amount > max) return false;
    if (from !== null && t.timestamp < from) return false;
    if (to !== null && t.timestamp > to) return false;
    if (addr) {
      const inFrom = matchAddr(t.from, t.fromUsername);
      const inTo = matchAddr(t.to, t.toUsername);
      if (f.addrSide === "from" && !inFrom) return false;
      if (f.addrSide === "to" && !inTo) return false;
      if (f.addrSide === "any" && !inFrom && !inTo) return false;
    }
    return true;
  });
  switch (f.sort) {
    case "oldest": out.sort((a, b) => a.timestamp - b.timestamp); break;
    case "amount-desc": out.sort((a, b) => b.amount - a.amount); break;
    case "amount-asc": out.sort((a, b) => a.amount - b.amount); break;
    default: out.sort((a, b) => b.timestamp - a.timestamp);
  }
  return out;
}
function txFiltersActive(f: TxFilters): number {
  let n = 0;
  if (f.addr) n++;
  if (f.minAmount) n++;
  if (f.maxAmount) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.status !== "all") n++;
  if (f.kind !== "all") n++;
  if (f.sort !== "newest") n++;
  return n;
}
function blockFiltersActive(f: BlockFilters): number {
  let n = 0;
  if (f.winner) n++;
  if (f.minHeight) n++;
  if (f.maxHeight) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.hasTxs !== "all") n++;
  if (f.sort !== "newest") n++;
  return n;
}
function addrFiltersActive(f: AddrFilters): number {
  let n = 0;
  if (f.q) n++;
  if (f.minBalance) n++;
  if (f.hasMined !== "all") n++;
  if (f.hasTxs !== "all") n++;
  if (f.sort !== "balance-desc") n++;
  return n;
}

function FInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full bg-background/40 border border-border px-2 py-1.5 text-xs num focus:outline-none focus:border-[hsl(var(--warning))] placeholder:text-muted-foreground/60 placeholder:font-sans ${props.className || ""}`}
    />
  );
}
function FSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-background/40 border border-border px-2 py-1.5 text-xs focus:outline-none focus:border-[hsl(var(--warning))]">
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="label-eyebrow mb-1">{children}</div>;
}
function FilterPanel({ activeCount, onClear, defaultOpen = false, children }: { activeCount: number; onClear: () => void; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass">
      <div className="flex items-center justify-between px-3 py-2">
        <button onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 text-xs text-foreground/80 hover:text-foreground transition">
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span className="label-eyebrow !mb-0">Filters</span>
          {activeCount > 0 && (
            <span className="num text-[10px] px-1.5 py-0.5 bg-[hsl(var(--warning)/0.15)] text-[hsl(var(--warning))]">
              {activeCount}
            </span>
          )}
          <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {activeCount > 0 && (
          <button onClick={onClear}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition">
            <X className="w-3 h-3" /> clear all
          </button>
        )}
      </div>
      {open && <div className="border-t border-border/60 p-3">{children}</div>}
    </div>
  );
}

function BlockExplorer({ chain, blockInfo, mempool }: any) {
  const [tab, setTab] = useState<"overview" | "blocks" | "txs" | "mempool" | "addresses">("overview");
  const [query, setQuery] = useState("");
  const [selBlock, setSelBlock] = useState<number | null>(null);
  const [selTx, setSelTx] = useState<string | null>(null);
  const [selAddr, setSelAddr] = useState<string | null>(null);
  const [players, setPlayers] = useState<Relay.Player[]>([]);

  // Pagination per tab
  const [pBlocks, setPBlocks] = useState(0);
  const [pTxs, setPTxs] = useState(0);
  const [pMem, setPMem] = useState(0);
  const [pAddr, setPAddr] = useState(0);

  // Filters per tab
  const [txF, setTxF] = useState<TxFilters>(emptyTxFilters);
  const [memF, setMemF] = useState<TxFilters>(emptyTxFilters);
  const [blkF, setBlkF] = useState<BlockFilters>(emptyBlockFilters);
  const [addrF, setAddrF] = useState<AddrFilters>(emptyAddrFilters);

  // Reset page when switching tabs or when filters change
  useEffect(() => { setPBlocks(0); setPTxs(0); setPMem(0); setPAddr(0); }, [tab]);
  useEffect(() => { setPTxs(0); }, [txF]);
  useEffect(() => { setPMem(0); }, [memF]);
  useEffect(() => { setPBlocks(0); }, [blkF]);
  useEffect(() => { setPAddr(0); }, [addrF]);

  // Pull every registered player so addresses without any tx history still
  // appear in the explorer (e.g. freshly-created wallets that haven't mined
  // a block yet but have already been seen by the network).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await Relay.fetchPlayers();
      if (!cancelled) setPlayers(p);
    })();
    return () => { cancelled = true; };
  }, [chain.length, mempool.length]);

  const allTxs = useMemo(() => flattenChainTxs(chain), [chain]);
  const memTxs = useMemo(() => mempoolToTxs(mempool || []), [mempool]);

  // Aggregate addresses — start from the player registry (so zero-balance
  // addresses are still listed), then layer on tx-derived stats.
  const addressBook = useMemo(() => {
    const m = new Map<string, { address: string; username?: string; sent: number; received: number; mined: number; txCount: number; lastSeen: number }>();
    for (const p of players) {
      m.set(p.address, {
        address: p.address,
        username: p.username,
        sent: 0, received: 0, mined: 0, txCount: 0,
        lastSeen: p.lastActive ? new Date(p.lastActive).getTime() : 0,
      });
    }
    const touch = (addr: string, username?: string) => {
      if (!addr || addr === "coinbase") return;
      if (!m.has(addr)) m.set(addr, { address: addr, username, sent: 0, received: 0, mined: 0, txCount: 0, lastSeen: 0 });
      const e = m.get(addr)!;
      if (username && !e.username) e.username = username;
      return e;
    };
    for (const tx of allTxs) {
      const ts = tx.timestamp;
      if (tx.kind === "reward") {
        const e = touch(tx.to, tx.toUsername); if (e) { e.mined += tx.amount; e.lastSeen = Math.max(e.lastSeen, ts); }
      } else {
        const f = touch(tx.from, tx.fromUsername);
        const t = touch(tx.to, tx.toUsername);
        if (f) { f.sent += tx.amount + tx.fee; f.txCount++; f.lastSeen = Math.max(f.lastSeen, ts); }
        if (t) { t.received += tx.amount; t.txCount++; t.lastSeen = Math.max(t.lastSeen, ts); }
      }
    }
    return Array.from(m.values()).sort((a, b) => (b.mined + b.received) - (a.mined + a.received));
  }, [allTxs, players]);

  // Filtered lists
  const txsAll = useMemo(() => [...memTxs, ...allTxs], [memTxs, allTxs]);
  const txsFiltered = useMemo(() => applyTxFilters(txsAll, txF), [txsAll, txF]);
  const memFiltered = useMemo(() => applyTxFilters(memTxs, memF), [memTxs, memF]);

  const blocksFiltered = useMemo(() => {
    const winner = blkF.winner.trim().toLowerCase();
    const minH = blkF.minHeight === "" ? null : Number(blkF.minHeight);
    const maxH = blkF.maxHeight === "" ? null : Number(blkF.maxHeight);
    const from = dateToTs(blkF.dateFrom);
    const to = dateToTs(blkF.dateTo, true);
    const out = (chain as any[]).filter(b => {
      if (winner) {
        const ok = (b.winner || "").toLowerCase().includes(winner) ||
                   (b.winnerUsername || "").toLowerCase().includes(winner);
        if (!ok) return false;
      }
      if (minH !== null && b.height < minH) return false;
      if (maxH !== null && b.height > maxH) return false;
      if (from !== null && b.timestamp < from) return false;
      if (to !== null && b.timestamp > to) return false;
      const txCount = (b.transactions || []).length;
      if (blkF.hasTxs === "yes" && txCount === 0) return false;
      if (blkF.hasTxs === "no" && txCount > 0) return false;
      return true;
    });
    switch (blkF.sort) {
      case "oldest": out.sort((a, b) => a.height - b.height); break;
      case "reward-desc": out.sort((a, b) => Number(b.reward || 0) - Number(a.reward || 0)); break;
      case "score-desc": out.sort((a, b) => (b.winnerScore || 0) - (a.winnerScore || 0)); break;
      default: out.sort((a, b) => b.height - a.height);
    }
    return out;
  }, [chain, blkF]);

  const addrFiltered = useMemo(() => {
    const q = addrF.q.trim().toLowerCase();
    const minB = addrF.minBalance === "" ? null : Number(addrF.minBalance);
    const out = addressBook.filter(a => {
      if (q && !a.address.toLowerCase().includes(q) && !(a.username || "").toLowerCase().includes(q)) return false;
      const bal = a.received + a.mined - a.sent;
      if (minB !== null && bal < minB) return false;
      if (addrF.hasMined === "yes" && a.mined <= 0) return false;
      if (addrF.hasMined === "no" && a.mined > 0) return false;
      if (addrF.hasTxs === "yes" && a.txCount === 0) return false;
      if (addrF.hasTxs === "no" && a.txCount > 0) return false;
      return true;
    });
    switch (addrF.sort) {
      case "balance-asc": out.sort((a, b) => (a.received + a.mined - a.sent) - (b.received + b.mined - b.sent)); break;
      case "mined-desc": out.sort((a, b) => b.mined - a.mined); break;
      case "tx-desc": out.sort((a, b) => b.txCount - a.txCount); break;
      case "recent": out.sort((a, b) => b.lastSeen - a.lastSeen); break;
      case "username": out.sort((a, b) => (a.username || "~").localeCompare(b.username || "~")); break;
      default: out.sort((a, b) => (b.received + b.mined - b.sent) - (a.received + a.mined - a.sent));
    }
    return out;
  }, [addressBook, addrF]);

  // Search: returns matches across blocks, txs, addresses
  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return null;
    const blocks = chain.filter((b: any) =>
      String(b.height).includes(q) ||
      b.hash?.toLowerCase().includes(q) ||
      b.previousHash?.toLowerCase().includes(q) ||
      b.winner?.toLowerCase().includes(q) ||
      b.winnerUsername?.toLowerCase().includes(q) ||
      b.seed?.toLowerCase().includes(q)
    ).slice(0, 10);
    const txs = [...memTxs, ...allTxs].filter(t =>
      t.id.toLowerCase().includes(q) ||
      t.signature?.toLowerCase().includes(q) ||
      t.from?.toLowerCase().includes(q) ||
      t.to?.toLowerCase().includes(q) ||
      t.fromUsername?.toLowerCase().includes(q) ||
      t.toUsername?.toLowerCase().includes(q) ||
      String(t.amount).includes(q)
    ).slice(0, 15);
    const addresses = addressBook.filter(a =>
      a.address.toLowerCase().includes(q) ||
      a.username?.toLowerCase().includes(q)
    ).slice(0, 10);
    return { blocks, txs, addresses };
  }, [q, chain, allTxs, memTxs, addressBook]);

  const totalSupply = chain.reduce((s: number, b: any) => s + Number(b.reward || 0), 0);
  const totalTxs = allTxs.filter(t => t.kind === "transfer").length;
  const totalVolume = allTxs.filter(t => t.kind === "transfer").reduce((s, t) => s + t.amount, 0);
  const lastBlock = chain[chain.length - 1];

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="glass-hi p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by block #, address, tx hash, signature, username, seed…"
            className="w-full bg-background/40 border border-border rounded-none pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-[hsl(var(--warning))] num placeholder:font-sans placeholder:text-muted-foreground"
          />
        </div>
        {q && searchResults && (
          <div className="mt-3 space-y-2 max-h-80 overflow-y-auto">
            {searchResults.blocks.length === 0 && searchResults.txs.length === 0 && searchResults.addresses.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-4">No results for "{query}"</div>
            )}
            {searchResults.blocks.length > 0 && (
              <div>
                <div className="label-eyebrow mb-1.5">Blocks · {searchResults.blocks.length}</div>
                {searchResults.blocks.map((b: any) => (
                  <button key={b.height} onClick={() => { setTab("blocks"); setSelBlock(b.height); setQuery(""); }}
                    className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between text-xs">
                    <span className="num text-[hsl(var(--warning))]">#{b.height}</span>
                    <span className="num text-muted-foreground truncate mx-2">{shortHash(b.hash, 10)}</span>
                    <span className="text-foreground/70">{b.winnerUsername || shortHash(b.winner, 6)}</span>
                  </button>
                ))}
              </div>
            )}
            {searchResults.txs.length > 0 && (
              <div>
                <div className="label-eyebrow mb-1.5">Transactions · {searchResults.txs.length}</div>
                {searchResults.txs.map(t => (
                  <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); setQuery(""); }}
                    className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between text-xs">
                    <span className="num text-muted-foreground">{shortHash(t.id, 8)}</span>
                    <span className="num text-primary/80">{t.amount} ⬡</span>
                    <span className={`text-[10px] ${t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-foreground/60"}`}>
                      {t.status === "pending" ? "pending" : `block #${t.block}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {searchResults.addresses.length > 0 && (
              <div>
                <div className="label-eyebrow mb-1.5">Addresses · {searchResults.addresses.length}</div>
                {searchResults.addresses.map(a => (
                  <button key={a.address} onClick={() => { setTab("addresses"); setSelAddr(a.address); setQuery(""); }}
                    className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between text-xs">
                    <span className="text-foreground/80">{a.username || "anon"}</span>
                    <span className="num text-muted-foreground truncate mx-2">{shortHash(a.address, 8)}</span>
                    <span className="num text-primary/80">{(a.received + a.mined - a.sent).toFixed(2)} ⬡</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="glass flex items-center gap-1 px-2 overflow-x-auto">
        <ExplorerTabBtn active={tab === "overview"} onClick={() => setTab("overview")}>Overview</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "blocks"} onClick={() => setTab("blocks")} count={chain.length}>Blocks</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "txs"} onClick={() => setTab("txs")} count={allTxs.length}>Transactions</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "mempool"} onClick={() => setTab("mempool")} count={memTxs.length}>Mempool</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "addresses"} onClick={() => setTab("addresses")} count={addressBook.length}>Addresses</ExplorerTabBtn>
      </div>

      {tab === "overview" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <ExplorerStat label="Latest block" value={`#${blockInfo.height - 1}`} sub={lastBlock ? timeAgo(lastBlock.timestamp) : "—"} />
            <ExplorerStat label="Total supply" value={`${totalSupply.toFixed(2)}`} sub="$BLOB minted" />
            <ExplorerStat label="Transactions" value={totalTxs} sub={`${totalVolume.toFixed(2)} ⬡ volume`} />
            <ExplorerStat label="Pending" value={memTxs.length} sub="in mempool" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="label-eyebrow">Latest blocks</span>
                <button onClick={() => setTab("blocks")} className="text-[10px] text-[hsl(var(--warning))] hover:underline">View all →</button>
              </div>
              {[...chain].reverse().slice(0, 6).map((b: any) => (
                <button key={b.height} onClick={() => { setTab("blocks"); setSelBlock(b.height); }}
                  className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                  <span className="num text-[hsl(var(--warning))] shrink-0">#{b.height}</span>
                  <span className="text-foreground/80 truncate flex-1">{b.winnerUsername || shortHash(b.winner, 6)}</span>
                  <span className="num text-muted-foreground shrink-0">{(b.transactions || []).length} tx</span>
                  <span className="num text-primary/80 shrink-0">{Number(b.reward).toFixed(0)} ⬡</span>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="label-eyebrow">Latest transactions</span>
                <button onClick={() => setTab("txs")} className="text-[10px] text-[hsl(var(--warning))] hover:underline">View all →</button>
              </div>
              {[...memTxs, ...allTxs].slice(0, 6).map(t => (
                <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); }}
                  className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                  {t.kind === "reward"
                    ? <Trophy className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0" />
                    : <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <span className="num text-muted-foreground truncate flex-1">{shortHash(t.id, 6)}</span>
                  <span className="num text-primary/80 shrink-0">{t.amount} ⬡</span>
                  <span className={`text-[10px] shrink-0 ${t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-muted-foreground"}`}>
                    {t.status === "pending" ? "pending" : timeAgo(t.timestamp)}
                  </span>
                </button>
              ))}
              {allTxs.length === 0 && memTxs.length === 0 && (
                <div className="glass text-center py-6 text-xs text-muted-foreground">No transactions yet</div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "blocks" && (
        <div className="space-y-1.5">
          <FilterPanel activeCount={blockFiltersActive(blkF)} onClear={() => setBlkF(emptyBlockFilters)}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="col-span-2 sm:col-span-3 lg:col-span-2">
                <FieldLabel>Winner (address or username)</FieldLabel>
                <FInput value={blkF.winner} onChange={e => setBlkF({ ...blkF, winner: e.target.value })} placeholder="address or @username" />
              </div>
              <div>
                <FieldLabel>Min height</FieldLabel>
                <FInput type="number" value={blkF.minHeight} onChange={e => setBlkF({ ...blkF, minHeight: e.target.value })} placeholder="0" />
              </div>
              <div>
                <FieldLabel>Max height</FieldLabel>
                <FInput type="number" value={blkF.maxHeight} onChange={e => setBlkF({ ...blkF, maxHeight: e.target.value })} placeholder="∞" />
              </div>
              <div>
                <FieldLabel>From date</FieldLabel>
                <FInput type="date" value={blkF.dateFrom} onChange={e => setBlkF({ ...blkF, dateFrom: e.target.value })} />
              </div>
              <div>
                <FieldLabel>To date</FieldLabel>
                <FInput type="date" value={blkF.dateTo} onChange={e => setBlkF({ ...blkF, dateTo: e.target.value })} />
              </div>
              <div>
                <FieldLabel>Has transactions</FieldLabel>
                <FSelect value={blkF.hasTxs} onChange={v => setBlkF({ ...blkF, hasTxs: v as any })}
                  options={[{ v: "all", l: "Any" }, { v: "yes", l: "With txs" }, { v: "no", l: "Empty blocks" }]} />
              </div>
              <div>
                <FieldLabel>Sort by</FieldLabel>
                <FSelect value={blkF.sort} onChange={v => setBlkF({ ...blkF, sort: v as any })}
                  options={[{ v: "newest", l: "Newest" }, { v: "oldest", l: "Oldest" }, { v: "reward-desc", l: "Highest reward" }, { v: "score-desc", l: "Highest score" }]} />
              </div>
            </div>
          </FilterPanel>
          <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground num">
            <span>{blocksFiltered.length} of {chain.length} blocks</span>
          </div>
          <div className="glass-hi px-3 py-2.5 ring-1 ring-[hsl(var(--warning)/0.2)] grid grid-cols-[50px_1fr_60px_70px_40px] sm:grid-cols-[60px_1fr_80px_100px_50px] gap-2 items-center text-xs">
            <span className="num text-[hsl(var(--warning))]">#{blockInfo.height}</span>
            <span className="text-muted-foreground">⏳ mining · {blockInfo.remaining}s</span>
            <span className="text-muted-foreground">—</span>
            <span className="num text-[hsl(var(--warning))]">{blockInfo.reward} ⬡</span>
            <span className="num text-right text-muted-foreground">—</span>
          </div>
          <div className="grid grid-cols-[50px_1fr_60px_70px_40px] sm:grid-cols-[60px_1fr_80px_100px_50px] gap-2 px-3 py-1">
            {["Height", "Winner", "Score", "Reward", "Tx"].map(h => <div key={h} className="label-eyebrow">{h}</div>)}
          </div>
          {blocksFiltered.slice(pBlocks * PAGE_SIZE, (pBlocks + 1) * PAGE_SIZE).map((b: any) => (
            <div key={b.height}>
              <div onClick={() => setSelBlock(selBlock === b.height ? null : b.height)}
                className="glass px-3 py-2.5 cursor-pointer hover:bg-secondary/30 transition grid grid-cols-[50px_1fr_60px_70px_40px] sm:grid-cols-[60px_1fr_80px_100px_50px] gap-2 items-center text-xs">
                <span className="num text-muted-foreground">#{b.height}</span>
                <span className="truncate text-foreground/80">{b.winnerUsername || shortHash(b.winner, 8)}</span>
                <span className="num text-muted-foreground">{b.winnerScore > 0 ? b.winnerScore : "—"}</span>
                <span className="num text-primary/80">{b.reward > 0 ? `${b.reward} ⬡` : "—"}</span>
                <span className="num text-right text-muted-foreground">{(b.transactions || []).length}</span>
              </div>
              {selBlock === b.height && (
                <div className="glass-hi mt-1 p-3 text-xs space-y-1.5 overflow-x-auto">
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Hash</span><span className="num text-foreground/70 break-all">{b.hash}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Prev</span><span className="num text-foreground/70 break-all">{b.previousHash}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Seed</span><span className="num">{b.seed}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Time</span><span>{new Date(b.timestamp).toLocaleString()} · {timeAgo(b.timestamp)}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="label-eyebrow">Winner</span>
                    <button onClick={() => { setTab("addresses"); setSelAddr(b.winner); }}
                      className="num text-[hsl(var(--warning))] hover:underline text-left break-all">{b.winner || "—"}</button>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Mining entries</span><span className="num">{(b.miningEntries || []).length}</span></div>
                  {(b.transactions || []).length > 0 && (
                    <div className="pt-1.5 border-t border-border/50">
                      <div className="label-eyebrow mb-1">Transactions ({b.transactions.length})</div>
                      {b.transactions.map((tx: any, i: number) => (
                        <div key={i} className="num text-foreground/60 text-[11px]">
                          {tx.fromUsername || shortHash(tx.from, 6)} → {tx.toUsername || shortHash(tx.to, 6)} · {tx.amount} ⬡ · fee {tx.fee || 0}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <Pager page={pBlocks} setPage={setPBlocks} total={blocksFiltered.length} label="blocks" />
          {chain.length === 0 ? (
            <div className="glass text-center py-10 text-sm text-muted-foreground">Chain starts at genesis</div>
          ) : blocksFiltered.length === 0 && (
            <div className="glass text-center py-10 text-xs text-muted-foreground">No blocks match these filters</div>
          )}
        </div>
      )}

      {tab === "txs" && (
        <div className="space-y-1.5">
          <FilterPanel activeCount={txFiltersActive(txF)} onClear={() => setTxF(emptyTxFilters)}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="col-span-2 sm:col-span-2">
                <FieldLabel>Address (from / to)</FieldLabel>
                <FInput value={txF.addr} onChange={e => setTxF({ ...txF, addr: e.target.value })} placeholder="address or @username" />
              </div>
              <div>
                <FieldLabel>Side</FieldLabel>
                <FSelect value={txF.addrSide} onChange={v => setTxF({ ...txF, addrSide: v as any })}
                  options={[{ v: "any", l: "Either" }, { v: "from", l: "Sender (from)" }, { v: "to", l: "Recipient (to)" }]} />
              </div>
              <div>
                <FieldLabel>Type</FieldLabel>
                <FSelect value={txF.kind} onChange={v => setTxF({ ...txF, kind: v as any })}
                  options={[{ v: "all", l: "All" }, { v: "transfer", l: "Transfers" }, { v: "reward", l: "Block rewards" }]} />
              </div>
              <div>
                <FieldLabel>Min amount ⬡</FieldLabel>
                <FInput type="number" value={txF.minAmount} onChange={e => setTxF({ ...txF, minAmount: e.target.value })} placeholder="0" />
              </div>
              <div>
                <FieldLabel>Max amount ⬡</FieldLabel>
                <FInput type="number" value={txF.maxAmount} onChange={e => setTxF({ ...txF, maxAmount: e.target.value })} placeholder="∞" />
              </div>
              <div>
                <FieldLabel>From date</FieldLabel>
                <FInput type="date" value={txF.dateFrom} onChange={e => setTxF({ ...txF, dateFrom: e.target.value })} />
              </div>
              <div>
                <FieldLabel>To date</FieldLabel>
                <FInput type="date" value={txF.dateTo} onChange={e => setTxF({ ...txF, dateTo: e.target.value })} />
              </div>
              <div>
                <FieldLabel>Status</FieldLabel>
                <FSelect value={txF.status} onChange={v => setTxF({ ...txF, status: v as any })}
                  options={[{ v: "all", l: "All" }, { v: "confirmed", l: "Confirmed" }, { v: "pending", l: "Pending" }]} />
              </div>
              <div>
                <FieldLabel>Sort by</FieldLabel>
                <FSelect value={txF.sort} onChange={v => setTxF({ ...txF, sort: v as any })}
                  options={[{ v: "newest", l: "Newest" }, { v: "oldest", l: "Oldest" }, { v: "amount-desc", l: "Largest amount" }, { v: "amount-asc", l: "Smallest amount" }]} />
              </div>
            </div>
          </FilterPanel>
          <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground num">
            <span>{txsFiltered.length} of {txsAll.length} transactions</span>
            {txsFiltered.length > 0 && (
              <span>volume {txsFiltered.reduce((s, t) => s + t.amount, 0).toFixed(2)} ⬡</span>
            )}
          </div>
          <div className="grid grid-cols-[18px_1fr_70px_60px_60px] sm:grid-cols-[18px_1fr_1fr_80px_70px_80px] gap-2 px-3 py-1">
            {["", "From", "To", "Amount", "Block", "Time"].slice(0, window.innerWidth < 640 ? 5 : 6).map(h => <div key={h} className="label-eyebrow">{h}</div>)}
          </div>
          {txsFiltered.length === 0 && (
            <div className="glass text-center py-10 text-sm text-muted-foreground">
              {txsAll.length === 0 ? "No transactions yet" : "No transactions match these filters"}
            </div>
          )}
          {txsFiltered.slice(pTxs * PAGE_SIZE, (pTxs + 1) * PAGE_SIZE).map(t => (
            <div key={t.id}>
              <div onClick={() => setSelTx(selTx === t.id ? null : t.id)}
                className="glass px-3 py-2.5 cursor-pointer hover:bg-secondary/30 transition grid grid-cols-[18px_1fr_70px_60px_60px] sm:grid-cols-[18px_1fr_1fr_80px_70px_80px] gap-2 items-center text-xs">
                {t.kind === "reward"
                  ? <Trophy className="w-3.5 h-3.5 text-[hsl(var(--warning))]" />
                  : <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground" />}
                <span className="text-foreground/80 truncate">{t.kind === "reward" ? "Network Mint" : (t.fromUsername || shortHash(t.from, 6))}</span>
                <span className="hidden sm:block text-foreground/80 truncate">{t.toUsername || shortHash(t.to, 6)}</span>
                <span className="num text-primary/80">{t.amount} ⬡</span>
                <span className="num text-muted-foreground">{t.status === "pending" ? "—" : `#${t.block}`}</span>
                <span className={`num text-right ${t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-muted-foreground"}`}>
                  {t.status === "pending" ? "pending" : timeAgo(t.timestamp)}
                </span>
              </div>
              {selTx === t.id && (
                <div className="glass-hi mt-1 p-3 text-xs space-y-1.5 overflow-x-auto">
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">ID</span><span className="num text-foreground/70 break-all">{t.id}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="label-eyebrow">From</span>
                    <button onClick={() => { setTab("addresses"); setSelAddr(t.from); }} className="num text-[hsl(var(--warning))] hover:underline text-left break-all">
                      {t.kind === "reward" ? "Network Mint (block reward)" : t.from}
                    </button>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="label-eyebrow">To</span>
                    <button onClick={() => { setTab("addresses"); setSelAddr(t.to); }} className="num text-[hsl(var(--warning))] hover:underline text-left break-all">{t.to}</button>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Amount</span><span className="num">{t.amount} $BLOB</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Fee</span><span className="num">{t.fee} $BLOB</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Status</span>
                    <span className={t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-foreground/70"}>
                      {t.status === "pending" ? "⧗ pending in mempool" : `✓ confirmed in block #${t.block}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Time</span><span>{new Date(t.timestamp).toLocaleString()}</span></div>
                  {t.signature && (
                    <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Signature</span><span className="num text-foreground/60 break-all text-[10px]">{t.signature}</span></div>
                  )}
                </div>
              )}
            </div>
          ))}
          <Pager page={pTxs} setPage={setPTxs} total={txsFiltered.length} label="transactions" />
        </div>
      )}

      {tab === "mempool" && (
        <div className="space-y-2">
          <FilterPanel activeCount={txFiltersActive(memF)} onClear={() => setMemF(emptyTxFilters)}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="col-span-2 sm:col-span-2">
                <FieldLabel>Address (from / to)</FieldLabel>
                <FInput value={memF.addr} onChange={e => setMemF({ ...memF, addr: e.target.value })} placeholder="address or @username" />
              </div>
              <div>
                <FieldLabel>Side</FieldLabel>
                <FSelect value={memF.addrSide} onChange={v => setMemF({ ...memF, addrSide: v as any })}
                  options={[{ v: "any", l: "Either" }, { v: "from", l: "Sender (from)" }, { v: "to", l: "Recipient (to)" }]} />
              </div>
              <div>
                <FieldLabel>Min amount ⬡</FieldLabel>
                <FInput type="number" value={memF.minAmount} onChange={e => setMemF({ ...memF, minAmount: e.target.value })} placeholder="0" />
              </div>
              <div>
                <FieldLabel>Max amount ⬡</FieldLabel>
                <FInput type="number" value={memF.maxAmount} onChange={e => setMemF({ ...memF, maxAmount: e.target.value })} placeholder="∞" />
              </div>
              <div>
                <FieldLabel>From date</FieldLabel>
                <FInput type="date" value={memF.dateFrom} onChange={e => setMemF({ ...memF, dateFrom: e.target.value })} />
              </div>
              <div>
                <FieldLabel>To date</FieldLabel>
                <FInput type="date" value={memF.dateTo} onChange={e => setMemF({ ...memF, dateTo: e.target.value })} />
              </div>
              <div>
                <FieldLabel>Sort by</FieldLabel>
                <FSelect value={memF.sort} onChange={v => setMemF({ ...memF, sort: v as any })}
                  options={[{ v: "newest", l: "Newest" }, { v: "oldest", l: "Oldest" }, { v: "amount-desc", l: "Largest amount" }, { v: "amount-asc", l: "Smallest amount" }]} />
              </div>
            </div>
          </FilterPanel>
          <div className="glass-hi px-3 py-2.5 flex items-center justify-between text-xs">
            <span className="label-eyebrow">Pending pool</span>
            <span className="num text-muted-foreground">
              {memFiltered.length}{memFiltered.length !== memTxs.length && ` of ${memTxs.length}`} unconfirmed · {memFiltered.reduce((s, t) => s + t.amount, 0).toFixed(2)} ⬡ queued
            </span>
          </div>
          {memTxs.length === 0 ? (
            <div className="glass text-center py-10 text-xs text-muted-foreground">Mempool is empty · all transactions confirmed</div>
          ) : memFiltered.length === 0 ? (
            <div className="glass text-center py-10 text-xs text-muted-foreground">No pending transactions match these filters</div>
          ) : (
            <>
              {memFiltered.slice(pMem * PAGE_SIZE, (pMem + 1) * PAGE_SIZE).map(t => (
                <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); }}
                  className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition border-l-2 border-l-[hsl(var(--warning))]">
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="text-foreground/80">{t.fromUsername || shortHash(t.from, 8)} → {shortHash(t.to, 8)}</span>
                    <span className="num text-primary/90">{t.amount} ⬡</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="num">fee {t.fee}</span>
                    <span className="num">{shortHash(t.id, 8)}</span>
                    <span className="text-[hsl(var(--warning))]">⧗ {timeAgo(t.timestamp)}</span>
                  </div>
                </button>
              ))}
              <Pager page={pMem} setPage={setPMem} total={memFiltered.length} label="pending" />
            </>
          )}

          {/* Recently confirmed */}
          <div className="pt-2">
            <div className="label-eyebrow mb-2 px-1">Recently confirmed</div>
            {allTxs.filter(t => t.kind === "transfer").slice(0, 10).map(t => (
              <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); }}
                className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                <span className="text-foreground/70 truncate">{t.fromUsername || shortHash(t.from, 6)} → {t.toUsername || shortHash(t.to, 6)}</span>
                <span className="num text-primary/80 shrink-0">{t.amount} ⬡</span>
                <span className="num text-muted-foreground shrink-0">#{t.block}</span>
              </button>
            ))}
            {allTxs.filter(t => t.kind === "transfer").length === 0 && (
              <div className="text-[11px] text-muted-foreground text-center py-3">No confirmed transactions yet</div>
            )}
          </div>
        </div>
      )}

      {tab === "addresses" && (
        <div className="space-y-1.5">
          {selAddr ? (
            (() => {
              const a = addressBook.find(x => x.address === selAddr);
              const addrTxs = [...memTxs, ...allTxs].filter(t => t.from === selAddr || t.to === selAddr);
              const balance = (a?.received || 0) + (a?.mined || 0) - (a?.sent || 0);
              return (
                <div className="space-y-3">
                  <button onClick={() => setSelAddr(null)} className="text-xs text-muted-foreground hover:text-foreground">← Back to addresses</button>
                  <div className="glass-hi p-4 space-y-2">
                    <div className="label-eyebrow">Address</div>
                    <div className="num text-sm text-foreground/90 break-all">{selAddr}</div>
                    {a?.username && <div className="text-xs text-muted-foreground">@{a.username}</div>}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <ExplorerStat label="Balance" value={`${balance.toFixed(4)}`} sub="$BLOB" />
                    <ExplorerStat label="Mined" value={(a?.mined || 0).toFixed(2)} sub="from blocks" />
                    <ExplorerStat label="Received" value={(a?.received || 0).toFixed(2)} />
                    <ExplorerStat label="Sent" value={(a?.sent || 0).toFixed(2)} />
                  </div>
                  <div className="label-eyebrow px-1">Transactions ({addrTxs.length})</div>
                  {addrTxs.slice(0, 50).map(t => (
                    <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); }}
                      className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                      {t.kind === "reward"
                        ? <Trophy className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0" />
                        : t.from === selAddr
                          ? <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          : <ArrowDownLeft className="w-3.5 h-3.5 text-primary/80 shrink-0" />}
                      <span className="text-foreground/70 truncate flex-1">
                        {t.from === selAddr ? `→ ${shortHash(t.to, 8)}` : `← ${t.kind === "reward" ? "Network Mint" : shortHash(t.from, 8)}`}
                      </span>
                      <span className={`num shrink-0 ${t.from === selAddr ? "text-muted-foreground" : "text-primary/80"}`}>
                        {t.from === selAddr ? "-" : "+"}{t.amount} ⬡
                      </span>
                      <span className="num text-muted-foreground shrink-0 text-[10px]">{t.status === "pending" ? "pending" : `#${t.block}`}</span>
                    </button>
                  ))}
                </div>
              );
            })()
          ) : (
            <>
              <FilterPanel activeCount={addrFiltersActive(addrF)} onClear={() => setAddrF(emptyAddrFilters)}>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  <div className="col-span-2">
                    <FieldLabel>Address or username</FieldLabel>
                    <FInput value={addrF.q} onChange={e => setAddrF({ ...addrF, q: e.target.value })} placeholder="search…" />
                  </div>
                  <div>
                    <FieldLabel>Min balance ⬡</FieldLabel>
                    <FInput type="number" value={addrF.minBalance} onChange={e => setAddrF({ ...addrF, minBalance: e.target.value })} placeholder="0" />
                  </div>
                  <div>
                    <FieldLabel>Has mined</FieldLabel>
                    <FSelect value={addrF.hasMined} onChange={v => setAddrF({ ...addrF, hasMined: v as any })}
                      options={[{ v: "all", l: "Any" }, { v: "yes", l: "Miners only" }, { v: "no", l: "Non-miners" }]} />
                  </div>
                  <div>
                    <FieldLabel>Has transactions</FieldLabel>
                    <FSelect value={addrF.hasTxs} onChange={v => setAddrF({ ...addrF, hasTxs: v as any })}
                      options={[{ v: "all", l: "Any" }, { v: "yes", l: "Active" }, { v: "no", l: "Idle" }]} />
                  </div>
                  <div>
                    <FieldLabel>Sort by</FieldLabel>
                    <FSelect value={addrF.sort} onChange={v => setAddrF({ ...addrF, sort: v as any })}
                      options={[
                        { v: "balance-desc", l: "Highest balance" },
                        { v: "balance-asc", l: "Lowest balance" },
                        { v: "mined-desc", l: "Most mined" },
                        { v: "tx-desc", l: "Most active" },
                        { v: "recent", l: "Recently seen" },
                        { v: "username", l: "Username A→Z" },
                      ]} />
                  </div>
                </div>
              </FilterPanel>
              <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground num">
                <span>{addrFiltered.length} of {addressBook.length} addresses</span>
              </div>
              <div className="grid grid-cols-[1fr_1fr_80px_60px] sm:grid-cols-[1fr_1fr_100px_100px_60px] gap-2 px-3 py-1">
                {(window.innerWidth < 640 ? ["Address", "Username", "Balance", "Mined"] : ["Address", "Username", "Balance", "Mined", "Tx"]).map(h => <div key={h} className="label-eyebrow">{h}</div>)}
              </div>
              {addressBook.length === 0 ? (
                <div className="glass text-center py-10 text-xs text-muted-foreground">No addresses tracked yet</div>
              ) : addrFiltered.length === 0 && (
                <div className="glass text-center py-10 text-xs text-muted-foreground">No addresses match these filters</div>
              )}
              {addrFiltered.slice(pAddr * PAGE_SIZE, (pAddr + 1) * PAGE_SIZE).map(a => {
                const balance = a.received + a.mined - a.sent;
                return (
                  <button key={a.address} onClick={() => setSelAddr(a.address)}
                    className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition grid grid-cols-[1fr_1fr_80px_60px] sm:grid-cols-[1fr_1fr_100px_100px_60px] gap-2 items-center text-xs">
                    <span className="num text-foreground/80 truncate">{shortHash(a.address, 8)}</span>
                    <span className="text-primary/80 truncate">{a.username || "—"}</span>
                    <span className="num text-muted-foreground">{balance.toFixed(2)} ⬡</span>
                    <span className="num text-muted-foreground">{a.mined.toFixed(2)}</span>
                    <span className="hidden sm:block num text-right text-muted-foreground">{a.txCount}</span>
                  </button>
                );
              })}
              <Pager page={pAddr} setPage={setPAddr} total={addrFiltered.length} label="addresses" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── BRIDGE TO SOLANA ──────────────────────────────────────────────────────────
// User flow:
//   1. Enter amount + Solana recipient address.
//   2. App signs a normal $BLOB tx to the bridge deposit address with
//      memo `sol:<recipient>` and broadcasts it via the standard mempool.
//   3. We POST the tx id to bridge-mint to register a pending bridge request.
//   4. Once the tx is sealed in a block, the edge function mints exactly the
//      same amount of SPL tokens to the recipient on Solana (1:1, no fee).
//   5. The UI polls bridge-mint until status = 'minted' or 'failed'.
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function BridgeScreen({ wallet, chain, mempool, onBroadcast }: any) {
  const [config, setConfig] = useState<{ bridgeAddress: string; splMintAddress: string | null } | null>(null);
  const [solAddr, setSolAddr] = useState("");
  const [amt, setAmt] = useState("");
  const [st, setSt] = useState<"idle" | "signing" | "broadcasting" | "registering" | "waiting" | "minting" | "minted" | "failed">("idle");
  const [err, setErr] = useState("");
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [activeRequest, setActiveRequest] = useState<Relay.BridgeRequest | null>(null);
  const [history, setHistory] = useState<Relay.BridgeRequest[]>([]);
  const [copied, setCopied] = useState(false);

  const balance = calcBalance(wallet.address, chain, mempool);

  // Load bridge config + fee info + history.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cfg, fi, hist] = await Promise.all([
        Relay.fetchBridgeConfig(),
        Relay.fetchFeeInfo(),
        Relay.fetchBridgeHistory(wallet.address),
      ]);
      if (cancelled) return;
      if (cfg) setConfig(cfg);
      if (fi) setFeeInfo(fi);
      setHistory(hist);
    })();
    const id = setInterval(async () => {
      const hist = await Relay.fetchBridgeHistory(wallet.address);
      if (!cancelled) setHistory(hist);
    }, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [wallet.address]);

  // Poll the active request until it reaches a terminal state.
  useEffect(() => {
    if (!activeRequest) return;
    if (activeRequest.status === "minted" || activeRequest.status === "failed") return;
    const id = setInterval(async () => {
      const r = await Relay.pollBridgeRequest(activeRequest.blob_tx_id);
      if (!r) return;
      setActiveRequest(r);
      if (r.status === "minted") setSt("minted");
      else if (r.status === "failed") { setSt("failed"); setErr(r.error || "Mint failed"); }
      else if (r.status === "minting") setSt("minting");
      else if (r.status === "confirmed") setSt("minting");
      else setSt("waiting");
    }, 4000);
    return () => clearInterval(id);
  }, [activeRequest]);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;
  const activeFeeRate = Math.max(MIN_FEE_RATE, recRate);
  const parsedAmt = (() => { const n = parseFloat(amt); return Number.isFinite(n) && n > 0 ? to8(n) : 0; })();
  const memoStr = solAddr.trim() ? `sol:${solAddr.trim()}` : "";
  const memoLen = memoBytes(memoStr);
  const memoOver = memoLen > MAX_MEMO_BYTES;
  const previewBytes = config && parsedAmt > 0 && !memoOver
    ? estimateTxBytes(wallet.address, config.bridgeAddress, parsedAmt, Date.now(), activeFeeRate, memoStr)
    : 0;
  const previewFee = previewBytes ? feeFromRate(activeFeeRate, previewBytes) : 0;
  const previewTotal = parsedAmt + previewFee;

  const validSol = SOL_ADDR_RE.test(solAddr.trim());
  const canSubmit =
    !!config && st === "idle" && validSol && parsedAmt > 0 && !memoOver && previewTotal <= balance;

  async function bridge() {
    setErr("");
    if (!config) { setErr("Bridge not configured"); return; }
    if (!validSol) { setErr("Invalid Solana address"); return; }
    if (parsedAmt <= 0) { setErr("Invalid amount"); return; }
    if (memoOver) { setErr(`Memo too long (${memoLen}/${MAX_MEMO_BYTES})`); return; }
    if (previewTotal > balance) { setErr("Insufficient balance"); return; }

    setSt("signing");
    try {
      const ts = Date.now();
      const txid = (await sha256hex(`${wallet.address}${config.bridgeAddress}${parsedAmt}${ts}${activeFeeRate}${memoStr}`)).slice(0, 40);
      const data = `${wallet.address}→${config.bridgeAddress}:${parsedAmt}@${ts}|fr=${activeFeeRate}|m=${memoStr}`;
      const sig = await signData(wallet.privateKey, data);
      const bytes = canonicalTxBytes({
        from: wallet.address, to: config.bridgeAddress, amount: parsedAmt, timestamp: ts,
        feeRate: activeFeeRate, memo: memoStr, publicKey: wallet.publicKey, signature: sig,
      });
      const fee = feeFromRate(activeFeeRate, bytes);
      const tx = {
        id: txid,
        from: wallet.address, fromUsername: wallet.username,
        to: config.bridgeAddress, amount: parsedAmt, fee,
        feeRate: activeFeeRate, memo: memoStr,
        signature: sig, publicKey: wallet.publicKey,
        timestamp: ts, status: "pending",
      };

      setSt("broadcasting");
      const res = await Relay.pushTx(tx);
      if (!res.ok) { setErr(res.error || "Broadcast failed"); setSt("failed"); return; }
      onBroadcast(tx);

      setSt("registering");
      const reg = await Relay.registerBridgeRequest({
        blob_tx_id: txid,
        sol_address: solAddr.trim(),
        amount: parsedAmt,
        from_address: wallet.address,
        from_username: wallet.username,
      });
      if (!reg.ok || !reg.data) { setErr(reg.error || "Bridge registration failed"); setSt("failed"); return; }
      setActiveRequest(reg.data);
      setSt(reg.data.status === "minted" ? "minted"
         : reg.data.status === "minting" ? "minting"
         : reg.data.status === "confirmed" ? "minting"
         : "waiting");
      setAmt(""); setSolAddr("");
    } catch (e) { setErr(String(e)); setSt("failed"); }
  }

  function reset() {
    setSt("idle"); setErr(""); setActiveRequest(null);
  }

  const copyBridge = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config.bridgeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const StatusPill = ({ status }: { status: Relay.BridgeRequest["status"] }) => {
    const map = {
      pending:   { text: "Waiting for block",  cls: "text-muted-foreground border-border" },
      confirmed: { text: "Confirmed on Blob",  cls: "text-primary border-primary/40" },
      minting:   { text: "Minting on Solana",  cls: "text-primary border-primary/40" },
      minted:    { text: "Minted",             cls: "text-[hsl(var(--success,142_70%_45%))] border-[hsl(var(--success,142_70%_45%))]/40" },
      failed:    { text: "Failed",             cls: "text-destructive border-destructive/40" },
    } as const;
    const m = map[status];
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${m.cls}`}>
        {status === "minted" ? <CheckCircle2 className="w-3 h-3" />
         : status === "failed" ? <AlertCircle className="w-3 h-3" />
         : <Loader2 className="w-3 h-3 animate-spin" />}
        {m.text}
      </span>
    );
  };

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl glass-hi px-5 sm:px-8 py-8 sm:py-10">
        <div className="pointer-events-none absolute -top-32 right-0 w-[420px] h-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 border border-primary/30 text-primary">
              <ArrowLeftRight className="w-4 h-4" />
            </div>
            <span className="label-eyebrow">Bridge</span>
          </div>
          <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight">
            <span className="text-foreground">Bridge </span>
            <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)]">$BLOB</span>
            <span className="text-foreground"> to Solana</span>
          </h1>
          <div className="text-sm text-muted-foreground max-w-xl leading-relaxed">
            Send $BLOB to the bridge address — we mint the same amount of SPL tokens to your Solana
            wallet, 1&nbsp;:&nbsp;1, no bridge fee. You only pay the standard network fee on Blob Chain.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Form */}
        <div className="lg:col-span-2 space-y-4">
          <div className="glass-hi p-5 sm:p-6 space-y-4">
            <div className="label-eyebrow">Bridge $BLOB → SPL</div>

            {/* Bridge address (read-only) */}
            <div className="space-y-1.5">
              <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                Bridge deposit address
              </Label>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-card/40">
                <span className="num text-xs text-foreground/80 truncate flex-1">
                  {config?.bridgeAddress ?? "Loading…"}
                </span>
                <button
                  type="button"
                  onClick={copyBridge}
                  disabled={!config}
                  className="text-[10px] px-2 py-1 rounded border border-border hover:border-primary/40 hover:text-primary transition shrink-0 disabled:opacity-50"
                >
                  {copied ? "Copied" : <><Copy className="w-3 h-3 inline -mt-0.5" /> Copy</>}
                </button>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Funds sent here are bridged automatically — never send manually from another wallet.
              </div>
            </div>

            {/* Solana recipient */}
            <div className="space-y-1.5">
              <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                Solana recipient address
              </Label>
              <Input
                value={solAddr}
                onChange={(e) => setSolAddr(e.target.value)}
                placeholder="e.g. 7xKXtg2C…  (base58, 32-44 chars)"
                className="num text-xs"
                spellCheck={false}
                autoComplete="off"
                disabled={st !== "idle" && st !== "failed" && st !== "minted"}
              />
              {solAddr.trim() && !validSol && (
                <div className="text-[10px] text-destructive">Not a valid Solana address</div>
              )}
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                  Amount
                </Label>
                <button
                  type="button"
                  onClick={() => setAmt(Math.max(0, balance - (previewFee || 0.0001)).toFixed(BLOB_DECIMALS))}
                  className="text-[10px] text-muted-foreground hover:text-primary transition"
                  disabled={balance <= 0}
                >
                  Max: <span className="num">{balance.toFixed(BLOB_DECIMALS)}</span>
                </button>
              </div>
              <div className="relative">
                <Input
                  value={amt}
                  onChange={(e) => setAmt(e.target.value)}
                  placeholder="0.00000000"
                  inputMode="decimal"
                  className="num pr-16"
                  disabled={st !== "idle" && st !== "failed" && st !== "minted"}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  $BLOB
                </span>
              </div>
            </div>

            {/* Fee preview */}
            {parsedAmt > 0 && (
              <div className="rounded-lg border border-border bg-card/30 p-3 text-[11px] space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">You send</span>
                  <span className="num">{parsedAmt.toFixed(BLOB_DECIMALS)} $BLOB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Network fee (~{previewBytes} B × {activeFeeRate} drops/B)</span>
                  <span className="num">{previewFee.toFixed(BLOB_DECIMALS)}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-1 mt-1">
                  <span className="text-muted-foreground">Total deducted</span>
                  <span className="num font-medium">{previewTotal.toFixed(BLOB_DECIMALS)}</span>
                </div>
                <div className="flex justify-between text-primary">
                  <span>You receive on Solana</span>
                  <span className="num">{parsedAmt.toFixed(BLOB_DECIMALS)} SPL</span>
                </div>
              </div>
            )}

            {err && (
              <div className="text-xs text-destructive flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {err}
              </div>
            )}

            <button
              type="button"
              onClick={bridge}
              disabled={!canSubmit}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:bg-primary/90 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
            >
              {st === "idle" || st === "minted" || st === "failed" ? (
                <><ArrowLeftRight className="w-4 h-4" /> Bridge to Solana</>
              ) : st === "signing" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Signing…</>
              ) : st === "broadcasting" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Broadcasting…</>
              ) : st === "registering" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Registering bridge…</>
              ) : st === "waiting" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for block…</>
              ) : (
                <><Loader2 className="w-4 h-4 animate-spin" /> Minting on Solana…</>
              )}
            </button>
          </div>

          {/* Active request status */}
          {activeRequest && (
            <div className="glass-hi p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="label-eyebrow">Latest bridge</div>
                <StatusPill status={activeRequest.status} />
              </div>
              <div className="grid grid-cols-2 gap-3 text-[11px]">
                <div>
                  <div className="text-muted-foreground mb-0.5">Amount</div>
                  <div className="num text-foreground">{Number(activeRequest.amount).toFixed(BLOB_DECIMALS)} $BLOB</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">Solana recipient</div>
                  <div className="num text-foreground truncate">{activeRequest.sol_address}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-muted-foreground mb-0.5">Blob tx</div>
                  <div className="num text-foreground truncate">{activeRequest.blob_tx_id}</div>
                </div>
                {activeRequest.sol_signature && (
                  <div className="col-span-2">
                    <div className="text-muted-foreground mb-0.5">Solana signature</div>
                    <a
                      href={`https://solscan.io/tx/${activeRequest.sol_signature}`}
                      target="_blank" rel="noreferrer"
                      className="num text-primary hover:underline inline-flex items-center gap-1 truncate"
                    >
                      {activeRequest.sol_signature}
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>
                )}
                {activeRequest.error && (
                  <div className="col-span-2 text-destructive">{activeRequest.error}</div>
                )}
              </div>
              {(activeRequest.status === "minted" || activeRequest.status === "failed") && (
                <button
                  onClick={reset}
                  className="text-[11px] px-3 py-1.5 rounded-full border border-border hover:border-primary/40 hover:text-primary transition"
                >
                  Bridge another
                </button>
              )}
            </div>
          )}
        </div>

        {/* History */}
        <div className="lg:col-span-1 space-y-2">
          <div className="label-eyebrow px-1">Your bridge history</div>
          {history.length === 0 ? (
            <div className="glass px-5 py-10 text-center text-sm text-muted-foreground">
              No bridges yet
            </div>
          ) : (
            <div className="space-y-1.5">
              {history.map((h) => (
                <div key={h.blob_tx_id} className="glass px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-sm font-medium">{Number(h.amount).toFixed(BLOB_DECIMALS)} $BLOB</span>
                    <StatusPill status={h.status} />
                  </div>
                  <div className="num text-[10px] text-muted-foreground truncate">→ {h.sol_address}</div>
                  {h.sol_signature && (
                    <a
                      href={`https://solscan.io/tx/${h.sol_signature}`}
                      target="_blank" rel="noreferrer"
                      className="num text-[10px] text-primary hover:underline inline-flex items-center gap-1 truncate"
                    >
                      {h.sol_signature.slice(0, 16)}…
                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WalletScreen({ wallet, chain, mempool, onBroadcast }: any) {
  const [copied, setCopied] = useState(false);
  const balance = calcBalance(wallet.address, chain, mempool);
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
            memo: tx.memo || "",
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
          memo: tx.memo || "",
        });
      }
    }
    return items.sort((a, b) => b.ts - a.ts);
  })();

  return (
    <div className="space-y-5">
      {/* Hero balance + address */}
      <div className="relative overflow-hidden rounded-3xl glass-hi px-5 sm:px-8 py-8 sm:py-10">
        <div className="pointer-events-none absolute -top-32 right-0 w-[420px] h-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="label-eyebrow">Balance</span>
                <span className="text-[10px] tracking-wider uppercase text-foreground/40">·</span>
                <span className="text-xs font-medium text-foreground/80">@{wallet.username}</span>
              </div>
              <div className="num text-4xl sm:text-6xl font-semibold leading-none text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)]">
                {balance.toFixed(BLOB_DECIMALS)}
                <span className="text-base sm:text-lg text-muted-foreground ml-2 font-normal">$BLOB</span>
              </div>
              {pending > 0 && (
                <div className="text-xs text-muted-foreground num mt-2">+{pending.toFixed(BLOB_DECIMALS)} incoming</div>
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

      {/* Send + History */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 order-1 lg:order-2">
          <div className="glass-hi p-5 sm:p-6 lg:sticky lg:top-20">
            <div className="label-eyebrow mb-4">Send $BLOB</div>
            <SendTxForm wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onBroadcast} />
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
                      {h.memo && (
                        <div className="text-[11px] text-foreground/70 italic truncate mt-0.5">
                          “{h.memo}”
                        </div>
                      )}
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
function NetworkView({ nodeCount, chain, blockInfo, mempool = [] }: any) {
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const info = await Relay.fetchFeeInfo();
      if (!cancelled && info) setFeeInfo(info);
    };
    load();
    const id = setInterval(load, 15_000);
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { cancelled = true; clearInterval(id); clearInterval(t); };
  }, []);

  // ── Supply / emission ──────────────────────────────────────────────────────
  const supply = calcTotalSupply(chain);
  const supplyPct = Math.min((supply / MAX_SUPPLY) * 100, 100);
  const totalTxs = chain.reduce((s: number, b: any) => s + (b.transactions || []).length, 0);
  const height = Math.max(0, chain.length - 1);

  // Halving math
  const halvingsDone = Math.floor(height / HALVING_BLOCKS);
  const blocksToNextHalving = HALVING_BLOCKS - (height % HALVING_BLOCKS);
  const secondsToNextHalving = blocksToNextHalving * BLOCK_TIME;
  const nextHalvingDate = new Date(Date.now() + secondsToNextHalving * 1000);
  const nextReward = blockInfo.reward / 2;

  // ── Block timing ───────────────────────────────────────────────────────────
  const remaining = blockInfo.remaining;
  const elapsedPct = Math.min(100, (blockInfo.elapsed / BLOCK_TIME) * 100);
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  // ── Mempool / difficulty ───────────────────────────────────────────────────
  const mpBytes = mempool.reduce((s: number, t: any) => {
    const sigLen = (t.signature || "").length || 128;
    const memoLen = memoBytes(t.memo || "");
    return s + 220 + sigLen + memoLen;
  }, 0);
  const load = Math.min(1, mpBytes / MAX_BLOCK_SIZE);
  const baseRate = feeInfo?.baseFeeRate ?? BASE_FEE_RATE;
  const recRate = feeInfo?.recommendedFeeRate ?? baseRate;
  const minRate = feeInfo?.minFeeRate ?? MIN_FEE_RATE;
  const congestionPct = Math.round(load * 100);
  const difficultyMult = recRate / baseRate;
  let congestionLabel = "Idle";
  let congestionTone = "text-[hsl(var(--info))]";
  if (load >= 0.66) { congestionLabel = "Congested"; congestionTone = "text-[hsl(var(--danger))]"; }
  else if (load >= 0.25) { congestionLabel = "Busy"; congestionTone = "text-[hsl(var(--warning))]"; }
  else if (load > 0) { congestionLabel = "Light"; congestionTone = "text-primary"; }

  // ── Recent activity ────────────────────────────────────────────────────────
  const recent = chain.slice(-10).reverse();
  const minedRecent = recent.filter((b: any) => b.winner).length;
  const fillRate = recent.length ? Math.round((minedRecent / recent.length) * 100) : 0;
  const avgTxsPerBlock = recent.length ? (recent.reduce((s: number, b: any) => s + (b.transactions || []).length, 0) / recent.length) : 0;

  // ── UI primitives ──────────────────────────────────────────────────────────
  const Stat = ({ label, value, sub, tone = "text-foreground" }: any) => (
    <div className="glass p-4 rounded-md">
      <div className="label-eyebrow">{label}</div>
      <div className={`num text-xl font-semibold mt-1.5 leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-foreground/50 mt-1 num">{sub}</div>}
    </div>
  );

  const Bar = ({ pct, tone = "bg-primary" }: { pct: number; tone?: string }) => (
    <div className="h-1.5 w-full bg-foreground/10 rounded-full overflow-hidden">
      <div className={`h-full ${tone} transition-all duration-700`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );

  const Row = ({ k, v, tone = "text-foreground" }: any) => (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-foreground/5 last:border-0">
      <span className="text-foreground/60">{k}</span>
      <span className={`num font-medium ${tone}`}>{v}</span>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 pb-1">
        <div>
          <div className="label-eyebrow text-primary">BLOB Network</div>
          <div className="text-2xl font-semibold tracking-tight mt-1">Live network state</div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-foreground/60">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
          ONLINE · {nodeCount} {nodeCount === 1 ? "node" : "nodes"}
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Chain height" value={height.toLocaleString()} sub={`${totalTxs} confirmed txs`} tone="text-primary" />
        <Stat label="Block reward" value={`${blockInfo.reward} $BLOB`} sub={`Halving #${halvingsDone + 1} → ${nextReward} $BLOB`} tone="text-[hsl(var(--warning))]" />
        <Stat label="Active nodes" value={nodeCount} sub="full validating" tone="text-[hsl(var(--info))]" />
        <Stat label="Mempool" value={mempool.length} sub={`${(mpBytes / 1024).toFixed(2)} KB queued`} tone={congestionTone} />
      </div>

      {/* Next block countdown */}
      <div className="glass p-5 rounded-md">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="label-eyebrow">Next block</div>
            <div className="text-sm text-foreground/60 mt-0.5">Block #{blockInfo.height} · {BLOCK_TIME}s target</div>
          </div>
          <div className="num text-3xl font-semibold tabular-nums tracking-tight text-primary">{mm}:{ss}</div>
        </div>
        <Bar pct={elapsedPct} />
        <div className="flex justify-between text-[11px] text-foreground/50 mt-1.5 num">
          <span>{blockInfo.elapsed}s elapsed</span>
          <span>{remaining}s remaining</span>
        </div>
      </div>

      {/* Difficulty / gas */}
      <div className="glass p-5 rounded-md">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="label-eyebrow">Network difficulty</div>
            <div className="text-sm text-foreground/60 mt-0.5">Gas pricing reflects mempool congestion</div>
          </div>
          <div className="text-right">
            <div className={`text-xs font-semibold uppercase tracking-wider ${congestionTone}`}>{congestionLabel}</div>
            <div className="num text-[11px] text-foreground/50 mt-0.5">{congestionPct}% load</div>
          </div>
        </div>
        <Bar pct={congestionPct} tone={load >= 0.66 ? "bg-[hsl(var(--danger))]" : load >= 0.25 ? "bg-[hsl(var(--warning))]" : "bg-primary"} />
        <div className="grid grid-cols-3 gap-2 mt-4">
          <div className="rounded-md border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/50">Slow</div>
            <div className="num text-sm font-semibold mt-1">{Math.max(minRate, Math.floor(recRate * 0.5))} <span className="text-[10px] text-foreground/50 font-normal">drops/B</span></div>
          </div>
          <div className="rounded-md border border-primary/30 bg-primary/[0.06] p-3">
            <div className="text-[10px] uppercase tracking-wider text-primary">Normal</div>
            <div className="num text-sm font-semibold mt-1 text-primary">{recRate} <span className="text-[10px] text-foreground/50 font-normal">drops/B</span></div>
          </div>
          <div className="rounded-md border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/50">Fast</div>
            <div className="num text-sm font-semibold mt-1">{Math.max(minRate, Math.ceil(recRate * 2))} <span className="text-[10px] text-foreground/50 font-normal">drops/B</span></div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-foreground/5">
          <Row k="Difficulty multiplier" v={`${difficultyMult.toFixed(2)}×`} tone={difficultyMult > 1 ? "text-[hsl(var(--warning))]" : "text-foreground"} />
          <Row k="Base fee rate" v={`${baseRate} drops/B`} />
          <Row k="Min fee rate (floor)" v={`${minRate} drops/B`} />
          <Row k="Max block size" v={`${(MAX_BLOCK_SIZE / 1000).toFixed(0)} KB`} />
        </div>
      </div>

      {/* $BLOB asset card */}
      <div className="glass p-5 rounded-md">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary text-sm">⬡</div>
            <div>
              <div className="text-sm font-semibold tracking-tight">$BLOB</div>
              <div className="text-[11px] text-foreground/50">Native asset · Proof-of-Gaming</div>
            </div>
          </div>
          <div className="text-right">
            <div className="num text-sm font-semibold">{supply.toFixed(2)}</div>
            <div className="text-[10px] text-foreground/50 num">/ {MAX_SUPPLY.toLocaleString()} max</div>
          </div>
        </div>
        <Bar pct={supplyPct} tone="bg-gradient-to-r from-primary to-[hsl(var(--info))]" />
        <div className="text-[11px] text-foreground/50 num mt-1.5">{supplyPct.toFixed(5)}% of max supply minted</div>
        <div className="mt-4 pt-4 border-t border-foreground/5">
          <Row k="Divisibility" v={`${BLOB_DECIMALS} decimals`} />
          <Row k="Base unit" v="1 drop = 0.00000001 $BLOB" />
          <Row k="Halving schedule" v={`Every ${HALVING_BLOCKS.toLocaleString()} blocks`} />
          <Row k="Halvings completed" v={halvingsDone} />
          <Row k="Blocks to next halving" v={blocksToNextHalving.toLocaleString()} />
          <Row k="Est. next halving" v={nextHalvingDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} tone="text-[hsl(var(--info))]" />
        </div>
      </div>

      {/* Recent activity */}
      <div className="glass p-5 rounded-md">
        <div className="label-eyebrow mb-3">Recent activity (last 10 blocks)</div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <Stat label="Block fill rate" value={`${fillRate}%`} sub={`${minedRecent}/${recent.length} mined`} tone={fillRate >= 70 ? "text-primary" : "text-[hsl(var(--warning))]"} />
          <Stat label="Avg txs/block" value={avgTxsPerBlock.toFixed(1)} sub="confirmed" />
        </div>
        <div className="flex items-end gap-1 h-12">
          {recent.slice().reverse().map((b: any, i: number) => {
            const txs = (b.transactions || []).length;
            const h = b.winner ? Math.max(20, Math.min(100, 35 + txs * 12)) : 8;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className={`w-full rounded-sm transition-all ${b.winner ? "bg-primary/70" : "bg-foreground/10"}`}
                  style={{ height: `${h}%` }}
                  title={`#${b.height} · ${txs} tx${b.winner ? ` · won by ${b.winnerUsername || "?"}` : " · empty"}`}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Consensus */}
      <div className="glass p-5 rounded-md">
        <div className="label-eyebrow mb-3">Consensus</div>
        <Row k="Algorithm" v="Proof-of-Gaming" tone="text-primary" />
        <Row k="Block time" v={`${BLOCK_TIME}s`} />
        <Row k="Winner selection" v="Weighted lottery" />
        <Row k="Score proof" v="ECDSA P-256" />
        <Row k="Tx fee model" v="drops/byte × tx size" />
        <Row k="Memo limit" v={`${MAX_MEMO_BYTES} bytes`} />
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

  // Username = global handle. Validate format & check the network for
  // collisions before we commit so users get instant feedback.
  const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
  async function validateUsername(name: string, ownAddress?: string): Promise<string | null> {
    const u = name.trim();
    if (!USERNAME_RE.test(u)) return "Username must be 3–24 chars (letters, numbers, _)";
    const { data } = await supabase.rpc("resolve_username", { p_username: u });
    const row = (data as any[])?.[0];
    if (row && row.address !== ownAddress) return `Username "${u}" is taken`;
    return null;
  }

  async function createWallet() {
    const name = nameIn.trim();
    if (!name) return;
    if (pass1.length < 6) { setConnectErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setConnectErr("Passphrases do not match"); return; }
    setCreating(true);
    setConnectErr("");
    try {
      const nameErr = await validateUsername(name);
      if (nameErr) { setConnectErr(nameErr); return; }
      const w: any = await generateWallet();
      w.username = name;
      await Vault.saveEncryptedWallet(w, pass1);
      // Register in the player registry so the address appears in Explorer
      // immediately, even before mining or any transaction.
      const ts = Date.now();
      const sig = await signData(w.privateKey, `register:${w.address}:${name}:${ts}`);
      const reg = await Relay.registerPlayer({
        address: w.address, username: name, publicKey: w.publicKey, signature: sig, timestamp: ts,
      });
      if (!reg.ok) { setConnectErr(reg.error || "Failed to register wallet"); return; }
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
    const name = nameIn.trim();
    if (!name) { setConnectErr("Enter a miner name"); return; }
    if (pass1.length < 6) { setConnectErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setConnectErr("Passphrases do not match"); return; }
    const priv = importJson.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{64}$/.test(priv)) {
      setConnectErr("Private key must be 64 hex characters (32 bytes)");
      return;
    }
    let publicKey: string, address: string;
    try {
      publicKey = bytesToHex(secp.getPublicKey(hexToBytes(priv), true));
      address = pubKeyToAddress(publicKey);
    } catch (e: any) {
      setConnectErr("Invalid private key"); return;
    }
    // Allow re-using the existing handle for THIS address; reject if taken by another.
    const nameErr = await validateUsername(name, address);
    if (nameErr) { setConnectErr(nameErr); return; }
    const w: any = { address, publicKey, privateKey: priv, username: name };
    try {
      await Vault.saveEncryptedWallet(w, pass1);
      const ts = Date.now();
      const sig = await signData(priv, `register:${address}:${name}:${ts}`);
      const reg = await Relay.registerPlayer({
        address, username: name, publicKey, signature: sig, timestamp: ts,
      });
      if (!reg.ok) { setConnectErr(reg.error || "Failed to register wallet"); return; }
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

  const balance = wallet ? calcBalance(wallet.address, chain, mempool) : 0;
  const nav = [
    { id: "mine", text: "Mine" },
    { id: "wallet", text: "Wallet" },
    { id: "bridge", text: "Bridge" },
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
                <div className="text-xs text-muted-foreground">Restore from an exported private key</div>
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
              <label className="label-eyebrow block mb-2">Private key (64 hex characters)</label>
              <textarea
                value={importJson}
                onChange={e => setImportJson(e.target.value)}
                placeholder="e.g. 1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"
                rows={3}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                className="num w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-[12px] leading-relaxed resize-none break-all"
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
    <div className="min-h-screen relative">
      {newBlock && (
        <div
          className={`fixed top-16 left-0 right-0 z-[1000] px-6 py-3 backdrop-blur-xl border-b text-center flex justify-center items-center gap-5 ${
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
                  <SendTxForm wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />
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
                  <DropdownMenuItem onClick={() => setScreen("bridge")} className="cursor-pointer">
                    <ArrowLeftRight className="w-4 h-4 mr-2" /> Bridge to Solana
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
                    <span className="text-foreground">{vaultPub ? "Unlock to mine " : "Connect to mine "}</span>
                    <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">$BLOB</span>
                  </h1>
                  <div className="text-sm text-muted-foreground mb-8 max-w-md mx-auto leading-relaxed">
                    Blob Run requires a wallet to sign your score and receive block rewards.
                  </div>
                  <button
                    onClick={vaultPub ? () => { setUnlockErr(""); setUnlockPass(""); setUnlockOpen(true); } : openConnect}
                    className="inline-flex items-center gap-2 px-8 py-4 rounded-full bg-primary text-primary-foreground font-semibold text-sm tracking-wide hover:bg-primary/90 transition shadow-[0_0_40px_hsl(var(--primary)/0.4)]"
                  >
                    {vaultPub ? <Lock className="w-4 h-4" /> : <Wallet className="w-4 h-4" />}
                    {vaultPub ? "Unlock wallet" : "Connect wallet"}
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
              <div className="text-sm text-muted-foreground">{vaultPub ? "Wallet locked" : "No wallet connected"}</div>
              <button
                onClick={vaultPub ? () => { setUnlockErr(""); setUnlockPass(""); setUnlockOpen(true); } : openConnect}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition"
              >
                {vaultPub ? <><Lock className="w-4 h-4" /> Unlock wallet</> : <><Wallet className="w-4 h-4" /> Connect wallet</>}
              </button>
            </div>
          )
        )}
        {screen === "bridge" && (
          wallet ? (
            <BridgeScreen wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />
          ) : (
            <div className="glass-hi p-10 text-center space-y-4">
              <div className="text-sm text-muted-foreground">{vaultPub ? "Wallet locked" : "No wallet connected"}</div>
              <button
                onClick={vaultPub ? () => { setUnlockErr(""); setUnlockPass(""); setUnlockOpen(true); } : openConnect}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition"
              >
                {vaultPub ? <><Lock className="w-4 h-4" /> Unlock wallet</> : <><Wallet className="w-4 h-4" /> Connect wallet</>}
              </button>
            </div>
          )
        )}
        {screen === "chain" && <BlockExplorer chain={chain} blockInfo={blockInfo} mempool={mempool} />}
        {screen === "network" && <NetworkView nodeCount={nodeCount} chain={chain} blockInfo={blockInfo} mempool={mempool} />}
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

      {/* Settings dialog — public/private keys live here */}
      <Dialog open={settingsOpen} onOpenChange={(o) => { setSettingsOpen(o); if (!o) setShowPriv(false); }}>
        <DialogContent className="glass-hi border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium tracking-wide flex items-center gap-2">
              <SettingsIcon className="w-4 h-4 text-primary" /> Wallet settings
            </DialogTitle>
          </DialogHeader>
          {wallet && (
            <div className="space-y-4 pt-1">
              <div>
                <div className="label-eyebrow mb-2">Miner name</div>
                <div className="text-sm font-medium">{wallet.username}</div>
              </div>
              <div>
                <div className="label-eyebrow mb-2">Address</div>
                <div className="num text-xs text-foreground/80 break-all leading-relaxed p-3 rounded-md bg-secondary/40 border border-border">
                  {wallet.address}
                </div>
              </div>
              <div>
                <div className="label-eyebrow mb-2">Public key (secp256k1, compressed)</div>
                <div className="num text-[10px] text-muted-foreground break-all leading-relaxed p-3 rounded-md bg-secondary/40 border border-border">
                  {wallet.publicKey}
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="label-eyebrow">Private key</div>
                  <button
                    onClick={() => setShowPriv(v => !v)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border border-destructive/30 text-destructive hover:bg-destructive/10 transition"
                  >
                    {showPriv ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Reveal</>}
                  </button>
                </div>
                {showPriv ? (
                  <div className="p-3 rounded-md border border-destructive/30 bg-destructive/5">
                    <div className="text-[11px] text-destructive mb-2">⚠ Never share this key — anyone with it controls your wallet</div>
                    <div className="num text-[10px] text-foreground/70 break-all leading-relaxed">{wallet.privateKey}</div>
                  </div>
                ) : (
                  <div className="num text-[10px] text-muted-foreground/50 break-all leading-relaxed p-3 rounded-md bg-secondary/40 border border-border select-none">
                    {"•".repeat(64)}
                  </div>
                )}
              </div>
              <div className="pt-2 border-t border-border flex gap-2">
                <button
                  onClick={() => { disconnectWallet(); setSettingsOpen(false); }}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-destructive/30 text-xs text-destructive hover:bg-destructive/10 transition"
                >
                  <LogOut className="w-3.5 h-3.5" /> Disconnect wallet
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <footer className="mt-12 py-6 text-center text-[11px] text-muted-foreground/60 num">
        Blob Chain © 2026
      </footer>
    </div>
  );
}
