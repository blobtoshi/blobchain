import { useEffect, useRef, useState, useCallback, memo } from "react";
<<<<<<< HEAD
import { Maximize2, Minimize2, RotateCw, Volume2, VolumeX, Palette } from "lucide-react";
=======
import { Maximize2, Minimize2, RotateCw } from "lucide-react";
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
import * as Relay from "@/lib/blobRelay";
import { CW, CH, GY, PX } from "@/lib/blob/constants";
import {
  drawBG, drawBlob, drawFork, drawLowBar, drawToken,
  _blobImg, ensureParticleSprite,
} from "@/lib/blob/level";
import {
  generateLevelPure, initialState, tick,
  encodeInputs, hashInputs, ENGINE_VERSION,
} from "@/lib/blob/simulator";
import { ENTRY_REVEAL_WINDOW_SECONDS } from "@/lib/blob/entryPow";
<<<<<<< HEAD
import {
  initSound, isMuted, toggleMuted,
  sfxJump, sfxLand, sfxDuck, sfxUnduck,
  sfxPickup, sfxCombo, sfxDeath,
} from "@/lib/blob/sound";
import { getCosmetics, subscribeCosmetics } from "@/lib/blob/cosmetics";
import { getBackgroundById } from "@/lib/blob/backgrounds";
import { getSkinById } from "@/lib/blob/skins";
import { getObstacleStyleById } from "@/lib/blob/obstacleStyles";
import CosmeticsModal from "@/components/blob/CosmeticsModal";
import BlobClashDevToggle from "@/components/blobclash/BlobClashDevToggle";
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

type InputEv = { f: number; t: number };
type SimState = ReturnType<typeof initialState>;
type Particle = { x: number; y: number; vx: number; vy: number; life: number; col: string; sz: number };
type Trail = { x: number; y: number; action: string };

const TRAIL_LEN = 4;
const MAX_PARTICLES = 96;

// Game world is a fixed 780×360 because the consensus simulator hard-codes
// those numbers (see node/lib/simulator.ts and src/lib/blob/simulator.ts —
// `780 + 8` literals). We render that world at the device's actual display
// size with a properly-sized backing buffer so it stays crisp at any aspect
// ratio. The DPR cap keeps the GPU load reasonable on cheap phones.
const MAX_DPR = 2;

// Fixed simulation timestep — independent of display refresh rate. The old
// loop ticked once per requestAnimationFrame, so the game ran 2× speed on
// 120 Hz screens and slow-mo on a 30 fps phone. With this we run a stable
// 60 sim-ticks/sec everywhere, regardless of how often the screen renders.
const SIM_HZ = 60;
const FRAME_MS = 1000 / SIM_HZ;
const MAX_FRAME_DT = 250; // clamp on tab-switch / long jank, prevent spiral

function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if (/iP(hone|ad|od)/.test(navigator.userAgent)) return true;
  // iPad on iOS 13+ reports as Mac; sniff via touch support.
  return navigator.userAgent.includes("Mac") && "ontouchend" in document;
}

type FsState =
  | { mode: "off" }
  | { mode: "native" }       // document.fullscreenElement is set
  | { mode: "ios-pseudo" };  // CSS pseudo-fullscreen on iOS Safari

<<<<<<< HEAD
function BlobRunGame({ wallet, blockInfo, blockTime, entries, onEntrySubmit }) {
=======
function BlobRunGame({ wallet, blockInfo, blockTime, onEntrySubmit }) {
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
  const blockTimeRef = useRef(blockTime);
  blockTimeRef.current = blockTime;

  // Commit phase has closed once we're inside the last
  // ENTRY_REVEAL_WINDOW_SECONDS of the block window. Past that point the
  // node rejects new commits, so we refuse to start (or restart) a run —
  // the player would just burn a run for nothing. In-progress runs are
  // unaffected: they finish naturally and submit through the normal path,
  // which the protocol decides to accept or reject.
<<<<<<< HEAD
  // Mirror the node's validateEntry exactly (matches MineHero gate):
  //   - commit phase (remaining > 30): always open
  //   - cutoff window (0 < remaining <= 30): always closed
  //   - overdue (remaining = 0 / overdue):
  //       * no entries yet -> "overdue grace", node still accepts entries,
  //         so the gate stays open to let the chain self-heal.
  //       * any entries -> gate closes, block will seal next tick.
  const remaining = blockTime?.remaining ?? blockInfo.remaining ?? Infinity;
  const overdue = remaining <= 0;
  const entryCount = (entries ?? []).length;
  const inOverdueGrace = overdue && entryCount === 0;
  const commitClosed = remaining <= ENTRY_REVEAL_WINDOW_SECONDS && !inOverdueGrace;
=======
  const remaining = blockTime?.remaining ?? blockInfo.remaining ?? Infinity;
  const commitClosed = remaining <= ENTRY_REVEAL_WINDOW_SECONDS;
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

  const cvs = useRef<HTMLCanvasElement | null>(null);
  const raf = useRef<number | null>(null);
  const stateRef = useRef<SimState | null>(null);
  const inputsRef = useRef<InputEv[]>([]);
  const jRef = useRef(false);
  const dRef = useRef(false);
  const stRef = useRef("idle");
  const renderRef = useRef<{ lastCombo: number }>({ lastCombo: 0 });
  const [gs, setGs] = useState({ status: "idle", score: 0, combo: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [fs, setFs] = useState<FsState>({ mode: "off" });
  const [isPortrait, setIsPortrait] = useState(false);
<<<<<<< HEAD
  // Mute state mirror: sound module owns the truth (and localStorage),
  // we keep a local snapshot so the button icon re-renders on toggle.
  // Initialised to whatever the sound module loaded from storage.
  const [muted, setMutedState] = useState<boolean>(() => {
    try { return isMuted(); } catch { return false; }
  });
  const onToggleMute = useCallback(() => {
    initSound(); // ensure ctx exists - this click is the gesture
    setMutedState(toggleMuted());
  }, []);

  // Cosmetics modal open/closed state.
  const [cosmeticsOpen, setCosmeticsOpen] = useState(false);

  // Active drawer refs - looked up from the registries and refreshed
  // whenever the user picks a new option via the subscribeCosmetics
  // listener below. The game loop reads `.current` every frame, so
  // swaps apply instantly without re-mounting the canvas or restarting
  // the run.
  const bgDrawRef        = useRef(getBackgroundById(getCosmetics().background).draw);
  const skinDrawRef      = useRef(getSkinById(getCosmetics().skin).draw);
  // trailImgRef tracks the active skin's `trailImage` so the trail/
  // after-image pass in BlobRunGame renders silhouettes of the right
  // sprite (e.g. Ninja trails ninjas, not default blobs).
  const trailImgRef      = useRef(getSkinById(getCosmetics().skin).trailImage);
  const obstacleStyleRef = useRef(getObstacleStyleById(getCosmetics().obstacles));
  useEffect(() => {
    return subscribeCosmetics((sel) => {
      bgDrawRef.current        = getBackgroundById(sel.background).draw;
      const skin               = getSkinById(sel.skin);
      skinDrawRef.current      = skin.draw;
      trailImgRef.current      = skin.trailImage;
      obstacleStyleRef.current = getObstacleStyleById(sel.obstacles);
    });
  }, []);

  // Track native fullscreen exits triggered by Esc / browser chrome so our
  // state stays in sync.
  useEffect(() => {
    const onChange = () => {
      const native = !!(document.fullscreenElement
        || (document as any).webkitFullscreenElement);
      setFs(prev => {
        if (native) return { mode: "native" };
        if (prev.mode === "native") return { mode: "off" };
        return prev;
      });
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

=======

  // Track native fullscreen exits triggered by Esc / browser chrome so our
  // state stays in sync.
  useEffect(() => {
    const onChange = () => {
      const native = !!(document.fullscreenElement
        || (document as any).webkitFullscreenElement);
      setFs(prev => {
        if (native) return { mode: "native" };
        if (prev.mode === "native") return { mode: "off" };
        return prev;
      });
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
  // Track orientation while in fullscreen so we can show the rotate-prompt
  // / apply iOS CSS rotation.
  useEffect(() => {
    const update = () => {
      if (typeof window === "undefined") return;
      setIsPortrait(window.matchMedia("(orientation: portrait)").matches);
    };
    update();
    const mq = window.matchMedia("(orientation: portrait)");
    const onChange = () => update();
    mq.addEventListener?.("change", onChange);
    window.addEventListener("orientationchange", onChange);
    window.addEventListener("resize", onChange);
    return () => {
      mq.removeEventListener?.("change", onChange);
      window.removeEventListener("orientationchange", onChange);
      window.removeEventListener("resize", onChange);
    };
  }, []);

  const enterFullscreen = useCallback(async () => {
    const el = wrapRef.current as (HTMLDivElement & {
      webkitRequestFullscreen?: () => Promise<void>;
    }) | null;
    if (!el) return;
    // iOS Safari can't fullscreen non-video elements — go straight to pseudo.
    if (isIOS()) {
      setFs({ mode: "ios-pseudo" });
      return;
    }
    const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
    if (!req) {
      setFs({ mode: "ios-pseudo" });
      return;
    }
    try {
      await req();
      setFs({ mode: "native" });
      // Lock to landscape on devices that support it (Android Chrome). The
      // call only resolves while we're inside fullscreen, and it rejects
      // silently on desktop / iOS — fine, we just ignore the rejection.
      try {
        await (screen.orientation as any)?.lock?.("landscape");
      } catch { /* orientation lock not supported here */ }
    } catch {
      // Some browsers reject requestFullscreen if not called from a true
      // user-gesture; fall back to pseudo so we still fill the screen.
      setFs({ mode: "ios-pseudo" });
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement || (document as any).webkitFullscreenElement) {
        const exit = (document as Document & {
          webkitExitFullscreen?: () => Promise<void>;
        });
        await (exit.exitFullscreen?.() ?? exit.webkitExitFullscreen?.());
      }
    } catch { /* ignore */ }
    try { (screen.orientation as any)?.unlock?.(); } catch { /* ignore */ }
    setFs({ mode: "off" });
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (fs.mode === "off") void enterFullscreen();
    else void exitFullscreen();
  }, [fs.mode, enterFullscreen, exitFullscreen]);

  const isFullscreen = fs.mode !== "off";
  const iosFs = fs.mode === "ios-pseudo";
  // Apply iOS CSS rotation only when we're in iOS pseudo-fullscreen and
  // the device is held in portrait. Once the user rotates physically, the
  // `isPortrait` flag flips and the rotation is removed.
  const applyIosRotate = iosFs && isPortrait;

  const level = useRef(generateLevelPure(blockInfo.seed));
  const bgNodes = useRef(Array.from({ length: 12 }, () => ({
    x: Math.random() * CW, y: 20 + Math.random() * (GY - 40),
    r: 2 + Math.random() * 9, a: .03 + Math.random() * .09,
    spd: .25 + Math.random() * .8,
  })));

  useEffect(() => {
    level.current = generateLevelPure(blockInfo.seed);
  }, [blockInfo.seed]);

  const recordEvent = useCallback((type) => {
    const s = stateRef.current;
    if (!s || s.dead) return;
    inputsRef.current.push({ f: s.frame + 1, t: type });
    // Sound: input events are gesture-driven so this is safe to fire from
    // here (no autoplay-policy concerns once initSound has run once).
    // v3: type 1 is no longer emitted, and landing sfx now fires from the
    // physics loop when the player actually touches the ground.
    if      (type === 0) sfxJump();
    else if (type === 2) sfxDuck();
    else if (type === 3) sfxUnduck();
  }, []);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        e.preventDefault();
        // jRef latches the key-down so OS auto-repeat (which fires keydown
        // many times while held) doesn't spam type-0 events. The latch is
        // cleared on keyup but NO release event is emitted - v3 jumps are
        // one-shot impulses.
        if (!jRef.current) { jRef.current = true; recordEvent(0); }
      }
      if (e.code === "ArrowDown") {
        e.preventDefault();
        if (!dRef.current) { dRef.current = true; recordEvent(2); }
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.code === "ArrowUp") {
        jRef.current = false; // clear latch; no event emitted in v3
      }
      if (e.code === "ArrowDown") {
        e.preventDefault();
        if (dRef.current) { dRef.current = false; recordEvent(3); }
      }
    };
    window.addEventListener("keydown", kd, { passive: false });
    window.addEventListener("keyup", ku, { passive: false });
    return () => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
    };
  }, [recordEvent]);

  const submitRun = useCallback(async (state: SimState) => {
    const finalScore = state.score;
    const frameCount = state.frame;
    if (finalScore <= 0) return;
    const canonical = encodeInputs(inputsRef.current);
    const inputsHash = await hashInputs(canonical);
    const entry = {
      block_height: blockInfo.height,
      block_seed: String(blockInfo.seed),
      address: wallet.address,
      score: finalScore,
      frame_count: frameCount,
      inputs: canonical,
      inputs_hash: inputsHash,
      engine_version: ENGINE_VERSION,
      signature: "",
      submitted_at: new Date().toISOString(),
    };
    onEntrySubmit(entry);
    const result = await Relay.pushEntry({
      ...entry,
      publicKey: wallet.publicKey,
      privateKey: wallet.privateKey,
    });
    if (!result.ok) {
      console.error("[submitRun] entry failed:", result.error, "phase:", result.phase);
    }
  }, [blockInfo, wallet, onEntrySubmit]);

  // ── Canvas sizing ──────────────────────────────────────────────────────
  // The visible canvas size is whatever the parent box gives us, preserving
  // the 780/360 aspect ratio (letterboxed if the container doesn't match).
  // The backing buffer is sized at displaySize × DPR (capped) so the canvas
  // is sharp at any zoom / fullscreen / device pixel density without the
  // browser bilinear-blurring a fixed 780×360 buffer up to 1080p.
  const fitCanvas = useCallback(() => {
    const canvas = cvs.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    // For natural-flow (non-fullscreen) the wrap defines width via aspect-ratio.
    // For fullscreen the wrap fills the screen and we fit-contain inside.
    const rect = canvas.getBoundingClientRect();
    let cssW = rect.width;
    let cssH = rect.height;
    if (cssW <= 0 || cssH <= 0) return;

    // Re-fit to preserve aspect ratio strictly (some flex+rotate combinations
    // can briefly hand us a non-conforming box).
    const worldAspect = CW / CH;
    const have = cssW / cssH;
    if (have > worldAspect) cssW = cssH * worldAspect;
    else                    cssH = cssW / worldAspect;

    const bufW = Math.max(1, Math.round(cssW * dpr));
    const bufH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bufW)  canvas.width  = bufW;
    if (canvas.height !== bufH) canvas.height = bufH;
  }, []);

  // Re-fit on mount, on resize, on orientation change, on fullscreen toggle,
  // and whenever the iOS-rotate flag flips.
  useEffect(() => {
    fitCanvas();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => fitCanvas());
    ro.observe(wrap);
    const onResize = () => fitCanvas();
    window.addEventListener("orientationchange", onResize);
    window.addEventListener("resize", onResize);
    document.addEventListener("fullscreenchange", onResize);
    document.addEventListener("webkitfullscreenchange", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", onResize);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("fullscreenchange", onResize);
      document.removeEventListener("webkitfullscreenchange", onResize);
    };
  }, [fitCanvas, isFullscreen, applyIosRotate]);

  const startRun = useCallback(() => {
    // Hard gate: refuse to start a new run once the commit phase has
    // ended. Covers the in-game "Run again" / "Start run" buttons and the
    // canvas tap-to-start handler. The MineHero LAUNCH button has its own
    // gate; this is the second line of defence for users who are already
    // inside the game when the window closes.
    if (commitClosed) return;
<<<<<<< HEAD
    // Init audio on first start. startRun is always called from a click or
    // tap handler so the browser allows the AudioContext to enter "running".
    initSound();
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
    if (raf.current != null) cancelAnimationFrame(raf.current);
    jRef.current = false; dRef.current = false;
    stRef.current = "playing";
    inputsRef.current = [];
    renderRef.current = { lastCombo: 0 };
    const lev = level.current;
    const state = initialState();
    stateRef.current = state;
    setGs({ status: "playing", score: 0, combo: 0 });

    const canvas = cvs.current;
    if (!canvas) return;
    fitCanvas();
    const ctx = canvas.getContext("2d", { alpha: false })!;
    ctx.imageSmoothingEnabled = false;

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

    const FNT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Inter, sans-serif';
    const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    // hudCache holds only the static background panel (rounded rect + rim).
    // Labels and values are painted live each frame so each character is
    // rendered exactly once instead of being layered against a cached
    // 45%-alpha version of itself - which is what caused the "thick/doubled"
    // look in the SCORE / BLOCK / SPEED headers.
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
    }

    let lastScore = -1;
    let scoreStr = "0";

    function drawHUD() {
      ctx.drawImage(hudCache, 0, 0);
      if (state.score !== lastScore) {
        lastScore = state.score;
        scoreStr = state.score.toLocaleString();
      }
      // Row 1: small uppercase labels at y=24, single pass at 45% alpha.
      ctx.fillStyle = "rgba(180, 220, 230, 0.45)";
      ctx.font = `9px ${FNT}`;
      ctx.textAlign = "left";   ctx.fillText("SCORE", 26, 24);
      ctx.textAlign = "center"; ctx.fillText(`BLOCK #${blockInfo.height}`, CW / 2, 24);
      ctx.textAlign = "right";  ctx.fillText(`SPEED \u00d7${state.speed.toFixed(1)}`, CW - 26, 24);
      // Row 2: big values at y=42.
      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 18px ${MONO}`;
      ctx.textAlign = "left";   ctx.fillText(scoreStr, 26, 42);
      ctx.fillStyle = "#7dffe0";
      ctx.textAlign = "center"; ctx.fillText(`#${blockInfo.height}`, CW / 2, 42);
      ctx.fillStyle = "#e7fff8";
      ctx.font = `600 14px ${MONO}`;
      ctx.textAlign = "right";  ctx.fillText(`${blockInfo.reward} BLOB`, CW - 26, 42);
      // Combo flourish - only when chained.
      if (state.combo > 1) {
        ctx.textAlign = "left";
        ctx.fillStyle = "#ffd166";
        ctx.font = `700 ${Math.min(13 + state.combo * 2, 26)}px ${FNT}`;
        ctx.fillText(`\u00d7${state.combo} combo`, 26, CH - 24);
      }
    }

    const trailBuf: Trail[] = new Array(TRAIL_LEN);
    for (let i = 0; i < TRAIL_LEN; i++) trailBuf[i] = { x: 0, y: 0, action: "" };
    let trailHead = 0;
    let trailCount = 0;

    function drawTrailAndBlob() {
      const p = state.player;
      // Trail uses the ACTIVE skin's image, not the hardcoded default,
      // so that e.g. the Ninja skin trails Ninja silhouettes instead of
      // default blobs. trailImgRef is kept in sync by the cosmetics
      // subscription set up above.
      const trailImg = trailImgRef.current;
      if (!state.locked && p.action !== "dead" && trailImg && trailImg.complete && trailImg.naturalWidth > 0) {
        const tT = p.wob * 0.08;
        const trailFloatY = p.action === "duck" ? 0 : Math.sin(tT) * 5;
        trailHead = (trailHead + TRAIL_LEN - 1) % TRAIL_LEN;
        const slot = trailBuf[trailHead];
        slot.x = PX;
        slot.y = p.y + trailFloatY - (p.action === "duck" ? 0 : 4);
        slot.action = p.action;
        if (trailCount < TRAIL_LEN) trailCount++;
        const duck = p.action === "duck";
        const baseW = duck ? 78 : 64;
        const baseH = duck ? 46 : 72;
        // Use save+translate+scale (NOT setTransform) so the outer DPR/world
        // scale set up at the top of draw() is preserved.
        ctx.save();
        for (let i = trailCount - 1; i >= 1; i--) {
          const tr = trailBuf[(trailHead + i) % TRAIL_LEN];
          ctx.globalAlpha = (1 - i / trailCount) * 0.28;
          ctx.save();
          ctx.translate(tr.x - i * 6, tr.y);
          ctx.scale(1, p.sq);
<<<<<<< HEAD
          ctx.drawImage(trailImg, -baseW / 2, -baseH / 2, baseW, baseH);
=======
          ctx.drawImage(_blobImg, -baseW / 2, -baseH / 2, baseW, baseH);
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
          ctx.restore();
        }
        ctx.restore();
      } else {
        trailCount = 0;
      }
    }

    function draw() {
      // Map world coords (CW × CH) → backing buffer (canvas.width × canvas.height).
      // Reset transform first, then apply DPR/world scale. Letterbox bands are
      // the canvas background colour — `alpha:false` plus the wrap's bg fills
      // them naturally.
      const sx = canvas.width / CW;
      const sy = canvas.height / CH;
      // fitCanvas() already locked the aspect ratio so sx ≈ sy. Use the
      // smaller to be safe against rounding and avoid clipping.
      const s = Math.min(sx, sy);
      ctx.setTransform(s, 0, 0, s, 0, 0);

      const p = state.player;
      const nodes = bgNodes.current;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.x -= n.spd;
        if (n.x < -15) n.x = CW + 15;
      }
      // Background drawn via the cosmetics registry. The default "Obsidian"
      // option wraps the original drawBG so it behaves identically; other
      // backgrounds may ignore `nodes` and render their own scene.
      bgDrawRef.current(ctx, state.frame, nodes);
      drawTrailAndBlob();
      const obs = state.obstacles;
      const obStyle = obstacleStyleRef.current;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        if (o.type === "low") obStyle.drawLowBar(ctx, o); else obStyle.drawFork(ctx, o);
      }
      const tks = state.tokens;
      for (let i = 0; i < tks.length; i++) {
        const t = tks[i];
        if (t.alive) drawToken(ctx, t.x, t.y, state.frame);
      }
      if (particleSprite) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let i = 0; i < MAX_PARTICLES; i++) {
          const pt = parts[i];
          if (pt.life <= 0) continue;
          ctx.globalAlpha = pt.life;
          const sz = pt.sz * 2;
          ctx.drawImage(particleSprite, pt.x - sz, pt.y - sz, sz * 2, sz * 2);
        }
        ctx.restore();
      }
      if (!state.dead) skinDrawRef.current(ctx, PX, p.y, p.action, p.wob, p.sq, false);
      drawHUD();
    }

    let acc = 0;
    let last = performance.now();
    let comboChanged = false;

    function stepOneTick(): boolean {
      const targetFrame = state.frame + 1;
      const queuedAtFrame: InputEv[] = [];
      for (let i = inputsRef.current.length - 1; i >= 0 && inputsRef.current[i].f === targetFrame; i--) {
        queuedAtFrame.unshift(inputsRef.current[i]);
      }
      // Snapshot the player's action BEFORE tick so we can detect a
      // jump->ground transition this frame. v3 removed type-1 events,
      // so the landing sfx can no longer fire from the input handler -
      // it has to fire here, when physics actually puts the player back
      // on the floor (either because their jump arc finished or because
      // they tapped a one-shot impulse jump that's now done).
      const wasJumping = state.player.action === "jump";
      const alive = tick(state, lev, queuedAtFrame);
      if (wasJumping && state.player.action !== "jump" && alive) {
        sfxLand();
      }
      const pickedThisFrame = state.tokensPickedThisFrame;
      if (pickedThisFrame > 0) {
        spawnParts(PX, state.player.y, "#00aaff", 8 * pickedThisFrame);
        // Pitch rises with combo so back-to-back pickups feel rewarding;
        // the sound module throttles to 40ms so multi-pickups in one
        // frame coalesce into a single tone.
        sfxPickup(state.combo);
      }
      if (!alive) {
        spawnParts(PX, state.player.y, "#ff2244", 18);
        spawnParts(PX, state.player.y, "#00ffcc", 8);
<<<<<<< HEAD
        sfxDeath();
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
        return false;
      }
      for (let i = 0; i < MAX_PARTICLES; i++) {
        const pt = parts[i];
        if (pt.life <= 0) continue;
        pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028;
      }
      const lastCombo = renderRef.current.lastCombo;
      if (
        (pickedThisFrame > 0 && state.combo !== lastCombo) ||
        (lastCombo > 0 && state.combo === 0)
      ) {
<<<<<<< HEAD
        // Combo milestone sound: every 5x stack (5, 10, 15, ...) plays a
        // little flourish. Don't fire on combo-breaks (state.combo === 0).
        if (state.combo > 0 && state.combo % 5 === 0 && state.combo > lastCombo) {
          sfxCombo(state.combo);
        }
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
        renderRef.current.lastCombo = state.combo;
        // Defer the React state update outside the inner sim loop so combos
        // crossed in a single render frame only flush one setGs call.
        comboChanged = true;
      }
      return true;
    }

    function loop(now: number) {
      if (stRef.current !== "playing") return;
      const dt = Math.min(now - last, MAX_FRAME_DT);
      last = now;
      acc += dt;
      let died = false;
      // Run as many fixed-timestep ticks as the elapsed time covers. Cap the
      // catch-up to 4 ticks/render so a hitch doesn't spiral into a 100ms
      // simulation burst that compounds into more lag.
      let ticksThisRender = 0;
      while (acc >= FRAME_MS && ticksThisRender < 4) {
        acc -= FRAME_MS;
        ticksThisRender++;
        if (!stepOneTick()) { died = true; break; }
      }
      if (died) {
        stRef.current = "dead";
        const finalScore = state.score;
        setGs({ status: "dead", score: finalScore, combo: 0 });
        renderRef.current.lastCombo = 0;
        // One final draw so the death frame includes the explosion particles.
        for (let i = 0; i < MAX_PARTICLES; i++) {
          const pt = parts[i];
          if (pt.life <= 0) continue;
          pt.x += pt.vx; pt.y += pt.vy; pt.vy += .18; pt.life -= .028;
        }
        draw();
        void submitRun(state);
        return;
      }
      draw();
      if (comboChanged) {
        comboChanged = false;
        setGs(prev => ({ ...prev, score: state.score, combo: state.combo }));
      }
      raf.current = requestAnimationFrame(loop);
    }

    raf.current = requestAnimationFrame(loop);
  }, [blockInfo, submitRun, fitCanvas, commitClosed]);

  useEffect(() => {
    startRun();
    return () => { if (raf.current != null) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Force-end any in-progress run the moment the commit phase closes. Without
  // this, a player who started during the open phase can keep playing past
  // the cutoff and submit a score that nobody else could compete with for
  // this block. The cutoff is the network-wide fair-play boundary; once it
  // passes, no new inputs may shape the run.
  //
  // We discard the run entirely rather than submit the partial score: the
  // node's simulator replay would reject a forcibly-terminated state because
  // it requires `result.dead === true`, which only happens when the player
  // actually loses to an obstacle. A "give up at frame N" code path would
  // need a new simulator input type and a protocol change. For now, dropping
  // the run is the right behaviour - the player tried to start too late.
  //
  // Exception (matches MineHero / node validator): if there are no entries
  // yet for this block, we're in the "overdue grace" path. commitClosed
  // already accounts for that, so this effect won't fire while the chain
  // is self-healing.
  useEffect(() => {
    if (!commitClosed) return;
    if (stRef.current !== "playing") return;
    if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    stRef.current = "expired";
    setGs({ status: "expired", score: 0, combo: 0 });
  }, [commitClosed]);

  // When a new block opens (commitClosed flips back to false), reset any
  // "expired" state so the player can launch a fresh run. The MineHero
  // LAUNCH button is the canonical entry point; from inside the game the
  // status returns to idle so tap-to-start works again.
  useEffect(() => {
    if (commitClosed) return;
    if (stRef.current !== "expired") return;
    stRef.current = "idle";
    setGs({ status: "idle", score: 0, combo: 0 });
  }, [commitClosed, blockInfo.height]);

  const onTapStart = (e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    if (gs.status === "idle" || gs.status === "dead") {
      // Same gate as the buttons — don't let a tap restart a run after
      // the commit window closes.
      if (commitClosed) return;
      startRun();
      return;
    }
    if (!jRef.current) { jRef.current = true; recordEvent(0); }
  };
  const onTapEnd = () => {
    // v3: clear the latch so a future tap can fire a fresh impulse jump,
    // but emit nothing - jump release is no longer a recorded event.
    jRef.current = false;
  };

  // Wrapper layout. Three layouts share most styles:
  //  • normal     — inline, 100% wide, aspect-locked at 780/360
  //  • fullscreen — fixed inset-0, flex-centred frame that fits the screen
  //                 while preserving the 780/360 aspect (letterboxing if
  //                 the screen aspect doesn't match)
  //  • iOS rotate — same as fullscreen but the inner frame is rotated 90°
  //                 so iPhone users in portrait still get a landscape view.
  const wrapClass = isFullscreen
    ? "fixed inset-0 z-50 bg-background flex items-center justify-center overflow-hidden"
    : "relative overflow-hidden border border-border/50 rounded-2xl";
  const wrapStyle: React.CSSProperties = isFullscreen
    ? { lineHeight: 0 }
    : { lineHeight: 0, boxShadow: "0 20px 60px hsl(220 50% 2% / 0.6)" };

  // Inner game frame — this is what the canvas actually fills. In normal
  // and standard-fullscreen modes it's just the full available space with
  // aspect locked. On iOS in portrait we rotate it 90° and swap the
  // dimensions (100dvh × matched-aspect height) to fake landscape.
  const frameStyle: React.CSSProperties = (() => {
    if (!isFullscreen) {
      return { width: "100%", aspectRatio: `${CW} / ${CH}` };
    }
    if (applyIosRotate) {
      // 100dvh = the longer screen dim (since we're in portrait) → becomes
      // the rotated frame's "width". Height follows from the world aspect.
      return {
        width: "100dvh",
        height: `calc(100dvh * ${CH} / ${CW})`,
        transform: "rotate(90deg)",
        transformOrigin: "center",
      };
    }
    // Standard fullscreen: fit the screen, preserve aspect.
    return {
      width: "min(100vw, calc(100dvh * 780 / 360))",
      height: "min(100dvh, calc(100vw * 360 / 780))",
    };
  })();

  return (
    <div className="space-y-2">
      {!isFullscreen && (
        <div className="flex justify-end gap-2">
          <button
            type="button"
            aria-label="Open cosmetics"
            onClick={() => setCosmeticsOpen(true)}
            onTouchEnd={(e) => { e.preventDefault(); setCosmeticsOpen(true); }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
          >
            <Palette className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label={muted ? "Unmute sound" : "Mute sound"}
            onClick={onToggleMute}
            onTouchEnd={(e) => { e.preventDefault(); onToggleMute(); }}
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
          >
            {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            aria-label="Enter fullscreen"
            onClick={toggleFullscreen}
            onTouchEnd={(e) => { e.preventDefault(); toggleFullscreen(); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent text-[10px] tracking-[0.2em] uppercase hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Fullscreen
          </button>
        </div>
      )}
      <div ref={wrapRef} className={wrapClass} style={wrapStyle}>
        <div style={{ position: "relative", ...frameStyle }}>
          <canvas
            ref={cvs}
            style={{
              display: "block",
              width: "100%",
              height: "100%",
              touchAction: "none",
              imageRendering: "auto",
            }}
            onTouchStart={onTapStart}
            onTouchEnd={onTapEnd}
            onTouchCancel={onTapEnd}
            onMouseDown={onTapStart}
            onMouseUp={onTapEnd}
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
              {commitClosed ? (
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    className="px-8 py-3 rounded-full bg-muted/20 border border-border/40 text-muted-foreground/70 text-sm font-semibold tracking-wide opacity-70 cursor-not-allowed"
                  >
                    COMMIT PHASE ENDED
                  </button>
                  <div className="text-[10px] tracking-[0.2em] text-muted-foreground/60 uppercase">
                    Wait for block #{blockInfo.height + 1}
                  </div>
                </div>
              ) : (
                <button
                  onClick={startRun}
                  className="px-8 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:scale-[1.02] transition-transform shadow-[0_0_30px_hsl(var(--primary)/0.4)]"
                >
                  Start run
                </button>
              )}
            </div>
          )}
          {gs.status === "dead" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/85 backdrop-blur-sm">
              <div className="text-[10px] tracking-[0.3em] text-destructive/80 mb-2">FORKED</div>
              <div className="num text-4xl sm:text-6xl font-semibold leading-none drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)] text-cyan-100">
                {gs.score.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mb-6">Block closes in {blockTimeRef.current?.remaining ?? blockInfo.remaining ?? 0}s · Replay sealed for verification</div>
              {commitClosed ? (
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    className="px-8 py-3 rounded-full bg-muted/20 border border-border/40 text-muted-foreground/70 text-sm font-semibold tracking-wide opacity-70 cursor-not-allowed"
                  >
                    COMMIT PHASE ENDED
                  </button>
                  <div className="text-[10px] tracking-[0.2em] text-muted-foreground/60 uppercase">
                    New entries reopen for block #{blockInfo.height + 1}
                  </div>
                </div>
              ) : (
                <button
                  onClick={startRun}
                  className="px-8 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:scale-[1.02] transition-transform shadow-[0_0_30px_hsl(var(--primary)/0.4)]"
                >
                  Run again
                </button>
              )}
            </div>
          )}
<<<<<<< HEAD
          {gs.status === "expired" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/85 backdrop-blur-sm">
              <div className="text-[10px] tracking-[0.3em] text-destructive/80 mb-2">RUN VOIDED</div>
              <div className="num text-2xl sm:text-3xl font-semibold leading-none text-muted-foreground/80 mb-1">
                COMMIT PHASE ENDED
              </div>
              <div className="text-xs text-muted-foreground mb-6 text-center max-w-xs">
                Your run was interrupted by the submission cutoff. New entries reopen for block #{blockInfo.height + 1}.
              </div>
              <button
                type="button"
                disabled
                aria-disabled="true"
                className="px-8 py-3 rounded-full bg-muted/20 border border-border/40 text-muted-foreground/70 text-sm font-semibold tracking-wide opacity-70 cursor-not-allowed"
              >
                AWAITING NEXT BLOCK
              </button>
            </div>
          )}
        </div>
        {isFullscreen && (
          <>
            <button
              type="button"
              aria-label="Open cosmetics"
              onClick={() => setCosmeticsOpen(true)}
              onTouchEnd={(e) => { e.preventDefault(); setCosmeticsOpen(true); }}
              className="absolute top-3 right-[6.5rem] z-20 p-2 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
            >
              <Palette className="w-4 h-4" />
            </button>
            <button
              type="button"
              aria-label={muted ? "Unmute sound" : "Mute sound"}
              onClick={onToggleMute}
              onTouchEnd={(e) => { e.preventDefault(); onToggleMute(); }}
              className="absolute top-3 right-14 z-20 p-2 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              aria-label="Exit fullscreen"
              onClick={toggleFullscreen}
              onTouchEnd={(e) => { e.preventDefault(); toggleFullscreen(); }}
              className="absolute top-3 right-3 z-20 p-2 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </>
=======
        </div>
        {isFullscreen && (
          <button
            type="button"
            aria-label="Exit fullscreen"
            onClick={toggleFullscreen}
            onTouchEnd={(e) => { e.preventDefault(); toggleFullscreen(); }}
            className="absolute top-3 right-3 z-20 p-2 rounded-full bg-background/60 backdrop-blur-sm border border-accent/40 text-accent hover:bg-accent/20 active:scale-95 transition shadow-[0_0_18px_hsl(var(--accent)/0.25)]"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
        )}
      </div>
      {!isFullscreen && (
        <div className="flex justify-center gap-6 text-[10px] tracking-[0.2em] text-muted-foreground/70 uppercase">
          <span>Space / ↑ Jump</span>
          <span>↓ Duck</span>
          <span>Ƀ +50 pts</span>
        </div>
      )}
<<<<<<< HEAD
      <CosmeticsModal open={cosmeticsOpen} onClose={() => setCosmeticsOpen(false)} />
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
    </div>
  );
}

<<<<<<< HEAD
// Inner memoized game component. Previously the default export; now wrapped
// by BlobRunGameWithDevToggle below so the BlobClash dev toggle can render
// above it. The memo comparator is unchanged.
const MemoizedBlobRunGame = memo(BlobRunGame, (prev, next) => {
=======
export default memo(BlobRunGame, (prev, next) => {
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
  if (prev.wallet !== next.wallet) return false;
  if (prev.blockInfo !== next.blockInfo) return false;
  if (prev.onEntrySubmit !== next.onEntrySubmit) return false;
  // Allow a re-render specifically when the commit-window state crosses
  // the threshold, so the in-game restart buttons can swap to the
  // disabled state. Per-second blockTime ticks otherwise keep getting
  // ignored so the canvas frame budget stays clean.
  const prevClosed = (prev.blockTime?.remaining ?? Infinity) <= ENTRY_REVEAL_WINDOW_SECONDS;
  const nextClosed = (next.blockTime?.remaining ?? Infinity) <= ENTRY_REVEAL_WINDOW_SECONDS;
  if (prevClosed !== nextClosed) return false;
  return true;
});
<<<<<<< HEAD

// Default export wraps the live game in the BlobClash dev toggle. The toggle
// is gated behind a dev access code and shows nothing extra to normal users
// (just a small "Dev" bar with a locked code field). Once unlocked it lets us
// switch the view to the in-development BlobClash game. All props pass through
// untouched to the live game.
//
// TEMPORARY (Phase 0 dev): when BlobClash ships and replaces BlobRun, delete
// the wrapper + the dev toggle component and export MemoizedBlobRunGame (or
// the new game) directly.
export default function BlobRunGameWithDevToggle(props: any) {
  return (
    <BlobClashDevToggle>
      <MemoizedBlobRunGame {...props} />
    </BlobClashDevToggle>
  );
}
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
