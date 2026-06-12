// BlobClash — 3D player view (three.js, stylized low-poly).
//
// Renders the SAME deterministic engine as the 2D view, in 3D: perspective
// camera at a strategy-game 3/4 angle following your blob, low-poly trees and
// rocks, spinning coins, flag-topped base platforms, fog depth, and a full
// "juice" layer - attack swing arcs, red damage pulses, death/respawn
// animations, pickup particles, a health bar with damage ghosting, and a red
// screen vignette when YOU take a hit.
//
// ARCHITECTURE RULE: the sim stays pure integer / fixed-point. This renderer
// only READS state (and the inputs it fed in) and interpolates visually at
// the display refresh rate. Nothing here feeds back into the sim. The attack
// cooldown lives in the engine (consensus); everything in this file is
// cosmetic.
//
// Asset note: all geometry is procedural low-poly primitives. To upgrade any
// element to real modeled art later, load a GLB and swap the mesh - the sim
// and the rest of this file are unaffected.
//
// Requires: npm install three

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  MAP_TILES, TILE_WALL, GAMEPLAY_TICKS, TICKS_PER_SEC,
  FP_ONE, COIN_SCORE, BASE_RADIUS, START_HEALTH,
  packInput, MOVE_NONE, DIR8, SLIME_NONE, SLIME_THROW, SLIME_DROP,
} from "@/lib/blobclash/constants";
import { initState, tick, finalScore, type ClashState } from "@/lib/blobclash/engine";
import { botInput } from "@/lib/blobclash/bots";
import { getCosmetics, subscribeCosmetics } from "@/lib/blob/cosmetics";
import { getSkinById } from "@/lib/blob/skins";

const PLAYER_COLORS = [
  0xff5c7a, 0x34d399, 0x60a5fa, 0xfbbf24, 0xa78bfa,
  0xf472b6, 0x22d3ee, 0xfb923c, 0x4ade80, 0xe879f9,
];
const PLAYER_COLORS_CSS = PLAYER_COLORS.map(c => "#" + c.toString(16).padStart(6, "0"));

// Aspect ratio for the play area (matches BlobRun's wide feel). The canvas
// fills its container's width and derives height from this ratio, so it scales
// responsively like the live game instead of being a fixed-size box.
const ASPECT = 16 / 9;
const HUMAN = 0;

// Mobile / tablet detection — touch controls only render when true. Checks
// both UA and touch capability + a coarse pointer so desktops with touch
// screens don't get the joystick unless they're genuinely touch-primary.
function detectTouch(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle|PlayBook|BB10/i.test(ua);
  const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
  const hasTouch = (navigator.maxTouchPoints ?? 0) > 0 || "ontouchstart" in window;
  return uaMobile || (coarse && hasTouch);
}

// Render-only per-tile hash for tree/rock variety (same as 2D view).
function tileHash(x: number, y: number): number {
  let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}

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

// Per-player render/animation state (NOT sim state - purely visual).
type AnimState = {
  prevX: number; prevY: number;       // fixed-point pos at previous tick (for interpolation)
  curX: number; curY: number;         // fixed-point pos at current tick
  dmgT: number;                       // 1 -> 0 red damage pulse
  atkT: number;                       // 1 -> 0 attack swing arc
  deathT: number;                     // 1 -> 0 death shrink (alive=false)
  lastHealth: number;
  lastAttackReady: number;
  lastCarried: number;
  lastBanked: number;
  lastAlive: boolean;
  yaw: number;                        // smoothed facing rotation
};

type Particle = {
  mesh: THREE.Mesh;
  vx: number; vy: number; vz: number;
  life: number;                       // seconds remaining
  active: boolean;
};

// ── Touch controls (mobile/tablet only) ───────────────────────────────────
// A draggable joystick (left) drives the move vector; action buttons (right)
// drive attack / steal / slime. All write into the refs the sim loop reads.
function TouchControls({
  moveRef, attackRef, stealRef, slimeActionRef, lDownRef,
}: {
  moveRef: React.MutableRefObject<{ x: number; y: number; active: boolean }>;
  attackRef: React.MutableRefObject<boolean>;
  stealRef: React.MutableRefObject<boolean>;
  slimeActionRef: React.MutableRefObject<number>;
  lDownRef: React.MutableRefObject<number>;
}) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);
  const touchIdRef = useRef<number | null>(null);

  const onStart = (e: React.TouchEvent) => {
    const t = e.changedTouches[0];
    touchIdRef.current = t.identifier;
    moveRef.current.active = true;
    updateKnob(t.clientX, t.clientY);
  };
  const onMove = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchIdRef.current) { updateKnob(t.clientX, t.clientY); e.preventDefault(); }
    }
  };
  const onEnd = (e: React.TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === touchIdRef.current) {
        touchIdRef.current = null;
        moveRef.current = { x: 0, y: 0, active: false };
        if (knobRef.current) knobRef.current.style.transform = "translate(-50%,-50%)";
      }
    }
  };
  const updateKnob = (cx: number, cy: number) => {
    const base = baseRef.current; if (!base) return;
    const r = base.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2);
    const dy = cy - (r.top + r.height / 2);
    const max = r.width / 2;
    const dist = Math.min(max, Math.hypot(dx, dy));
    const ang = Math.atan2(dy, dx);
    const nx = Math.cos(ang) * (dist / max);
    const ny = Math.sin(ang) * (dist / max);
    moveRef.current = { x: nx, y: ny, active: true };
    if (knobRef.current) {
      knobRef.current.style.transform = `translate(calc(-50% + ${Math.cos(ang) * dist}px), calc(-50% + ${Math.sin(ang) * dist}px))`;
    }
  };

  const btn = (bg: string): React.CSSProperties => ({
    width: 46, height: 46, borderRadius: "50%", border: "1px solid rgba(255,255,255,0.25)",
    background: bg, color: "rgba(255,255,255,0.85)", fontSize: 10, fontWeight: 700, display: "flex",
    alignItems: "center", justifyContent: "center", userSelect: "none", touchAction: "none",
    textShadow: "0 1px 3px rgba(0,0,0,0.6)", backdropFilter: "blur(1px)",
  });

  return (
    <>
      {/* Joystick (bottom-left) */}
      <div
        ref={baseRef}
        onTouchStart={onStart}
        onTouchMove={onMove}
        onTouchEnd={onEnd}
        onTouchCancel={onEnd}
        style={{
          position: "absolute", left: "4%", bottom: "8%", width: 96, height: 96,
          borderRadius: "50%", background: "rgba(255,255,255,0.06)",
          border: "1px solid rgba(255,255,255,0.15)", touchAction: "none", zIndex: 20,
          backdropFilter: "blur(1px)",
        }}
      >
        <div ref={knobRef} style={{
          position: "absolute", left: "50%", top: "50%", width: 40, height: 40,
          borderRadius: "50%", background: "rgba(255,255,255,0.4)",
          transform: "translate(-50%,-50%)", pointerEvents: "none",
        }} />
      </div>

      {/* Action buttons (bottom-right) */}
      <div style={{ position: "absolute", right: "4%", bottom: "8%", display: "flex", gap: 12, alignItems: "flex-end", zIndex: 20 }}>
        <div
          onTouchStart={(e) => { e.preventDefault(); const d = performance.now(); lDownRef.current = d; }}
          onTouchEnd={(e) => { e.preventDefault(); const held = performance.now() - lDownRef.current; slimeActionRef.current = held >= 180 ? SLIME_DROP : SLIME_THROW; lDownRef.current = 0; }}
          style={btn("rgba(120,220,140,0.32)")}
        >SLIME</div>
        <div
          onTouchStart={(e) => { e.preventDefault(); stealRef.current = true; }}
          onTouchEnd={(e) => { e.preventDefault(); stealRef.current = false; }}
          style={btn("rgba(96,165,250,0.32)")}
        >STEAL</div>
        <div
          onTouchStart={(e) => { e.preventDefault(); attackRef.current = true; }}
          onTouchEnd={(e) => { e.preventDefault(); attackRef.current = false; }}
          style={{ ...btn("rgba(255,92,122,0.38)"), width: 56, height: 56 }}
        >ATK</div>
      </div>
    </>
  );
}

export default function BlobClashPlayer3D({ seed }: { seed: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const keysRef = useRef<Set<string>>(new Set());
  const slimeActionRef = useRef<number>(SLIME_NONE);
  const lKeyDownAtRef = useRef<number>(0);
  const skinImgRef = useRef<HTMLImageElement | null>(null);
  const skinVersionRef = useRef(0);
  // Live canvas size (updated by ResizeObserver). Used for HOME arrow projection.
  const sizeRef = useRef({ w: 780, h: 439 });
  // Touch input state: a normalized joystick vector + held action buttons.
  const touchMoveRef = useRef({ x: 0, y: 0, active: false });
  const touchAttackRef = useRef(false);
  const touchStealRef = useRef(false);
  const [isTouch, setIsTouch] = useState(false);

  // DOM-overlay refs (mutated directly in the loop; no React re-render per frame)
  const healthFillRef = useRef<HTMLDivElement | null>(null);
  const healthGhostRef = useRef<HTMLDivElement | null>(null);
  const healthWrapRef = useRef<HTMLDivElement | null>(null);
  const vignetteRef = useRef<HTMLDivElement | null>(null);
  const homeArrowRef = useRef<HTMLDivElement | null>(null);

  const [hud, setHud] = useState({ carried: 0, banked: 0, secsLeft: Math.ceil(GAMEPLAY_TICKS / TICKS_PER_SEC) });
  const [status, setStatus] = useState<"playing" | "finished">("playing");
  const [finalStandings, setFinalStandings] = useState<{ idx: number; score: number }[]>([]);

  // Cosmetics subscription — the chosen skin renders as a billboard sprite.
  useEffect(() => {
    setIsTouch(detectTouch());
  }, []);

  useEffect(() => {
    const apply = () => {
      const cos = getCosmetics();
      const skin = getSkinById(cos.skin);
      skinImgRef.current = skin?.trailImage ?? null;
      skinVersionRef.current++;
    };
    apply();
    const unsub = subscribeCosmetics(apply);
    return () => { unsub?.(); };
  }, []);

  useEffect(() => {
    const mount = mountRef.current!;
    const st = initState(seed, 10);
    let running = true;

    // ── Renderer / scene / camera ──────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.domElement.style.borderRadius = "8px";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.appendChild(renderer.domElement);

    // Initial size from the container width (fallback 780 if not laid out yet).
    const initW = mount.clientWidth || 780;
    const initH = Math.round(initW / ASPECT);
    sizeRef.current = { w: initW, h: initH };
    renderer.setSize(initW, initH, false);

    const scene = new THREE.Scene();
    const BG = 0x0c130e;
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 18, 46);

    const camera = new THREE.PerspectiveCamera(50, initW / initH, 0.1, 200);
    // 3/4 strategy angle: back and up from the player, looking down at ~55°.
    const CAM_OFFSET = new THREE.Vector3(0, 13, 9);

    // Responsive resize: keep the canvas at container width / ASPECT.
    const resize = () => {
      const w = mount.clientWidth || initW;
      const h = Math.round(w / ASPECT);
      sizeRef.current = { w, h };
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // ── Lights ─────────────────────────────────────────────────────────
    scene.add(new THREE.HemisphereLight(0x9fd8a8, 0x0a0f0a, 0.55));
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.25);
    sun.position.set(18, 30, 12);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x3a4a3a, 0.35));

    // ── Ground ─────────────────────────────────────────────────────────
    // Per-tile shade variation baked into a tiny canvas texture (1px/tile,
    // nearest filter) for a clean stylized checker without geometry cost.
    const gcvs = document.createElement("canvas");
    gcvs.width = MAP_TILES; gcvs.height = MAP_TILES;
    const gctx = gcvs.getContext("2d")!;
    const shades = ["#15211a", "#182419", "#131e16", "#1a271c", "#16221b"];
    for (let y = 0; y < MAP_TILES; y++) {
      for (let x = 0; x < MAP_TILES; x++) {
        gctx.fillStyle = shades[tileHash(x, y) % 5];
        gctx.fillRect(x, y, 1, 1);
      }
    }
    const groundTex = new THREE.CanvasTexture(gcvs);
    groundTex.magFilter = THREE.NearestFilter;
    groundTex.minFilter = THREE.NearestFilter;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP_TILES, MAP_TILES),
      new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(MAP_TILES / 2, 0, MAP_TILES / 2);
    scene.add(ground);

    // ── Trees + rocks (instanced) from wall tiles ──────────────────────
    const treeTiles: { x: number; y: number; h: number }[] = [];
    const rockTiles: { x: number; y: number; h: number }[] = [];
    for (let y = 0; y < MAP_TILES; y++) {
      for (let x = 0; x < MAP_TILES; x++) {
        if (st.world.tiles[y * MAP_TILES + x] !== TILE_WALL) continue;
        const h = tileHash(x, y);
        (h % 10 < 7 ? treeTiles : rockTiles).push({ x, y, h });
      }
    }
    const tmpM = new THREE.Matrix4();
    const tmpC = new THREE.Color();

    // Canopies: faceted icosahedra; trunks: thin cylinders.
    const canopyGeo = new THREE.IcosahedronGeometry(0.46, 0);
    const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true });
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, treeTiles.length || 1);
    const trunkGeo = new THREE.CylinderGeometry(0.08, 0.11, 0.5, 6);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c3a26, roughness: 1 });
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeTiles.length || 1);
    const canopyShades = [0x2f6b3a, 0x357a42, 0x2c6537];
    treeTiles.forEach((t, i) => {
      const s = 0.9 + (t.h % 5) * 0.07;
      tmpM.makeScale(s, s * (1 + (t.h % 3) * 0.12), s);
      tmpM.setPosition(t.x + 0.5, 0.62 * s, t.y + 0.5);
      canopies.setMatrixAt(i, tmpM);
      canopies.setColorAt(i, tmpC.setHex(canopyShades[t.h % 3]));
      tmpM.makeScale(1, 1, 1);
      tmpM.setPosition(t.x + 0.5, 0.25, t.y + 0.5);
      trunks.setMatrixAt(i, tmpM);
    });
    canopies.instanceMatrix.needsUpdate = true;
    if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    scene.add(canopies, trunks);

    const rockGeo = new THREE.DodecahedronGeometry(0.42, 0);
    const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockTiles.length || 1);
    const rockShades = [0x6b7280, 0x5a6470, 0x737d88];
    rockTiles.forEach((t, i) => {
      const s = 0.85 + (t.h % 4) * 0.08;
      tmpM.makeRotationY((t.h % 8) * 0.7);
      tmpM.scale(new THREE.Vector3(s, s * 0.7, s));
      tmpM.setPosition(t.x + 0.5, 0.28 * s, t.y + 0.5);
      rocks.setMatrixAt(i, tmpM);
      rocks.setColorAt(i, tmpC.setHex(rockShades[t.h % 3]));
    });
    rocks.instanceMatrix.needsUpdate = true;
    if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
    scene.add(rocks);

    // ── Bases: platform + pole + flag, one per player ──────────────────
    const flagMats: THREE.MeshStandardMaterial[] = [];
    st.world.bases.forEach((b, i) => {
      const g = new THREE.Group();
      const size = BASE_RADIUS * 2 + 1;
      const plat = new THREE.Mesh(
        new THREE.BoxGeometry(size, 0.12, size),
        new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[i], roughness: 0.7, transparent: true, opacity: i === HUMAN ? 0.55 : 0.32 }),
      );
      plat.position.y = 0.06;
      g.add(plat);
      const rim = new THREE.Mesh(
        new THREE.BoxGeometry(size + 0.12, 0.06, size + 0.12),
        new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[i], roughness: 0.5 }),
      );
      rim.position.y = 0.03;
      g.add(rim);
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6),
        new THREE.MeshStandardMaterial({ color: 0xcfd6e0, roughness: 0.4 }),
      );
      pole.position.y = 0.85;
      g.add(pole);
      const flagMat = new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[i], side: THREE.DoubleSide, roughness: 0.8 });
      flagMats.push(flagMat);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.34), flagMat);
      flag.position.set(0.33, 1.4, 0);
      g.add(flag);
      g.position.set(b.x + 0.5, 0, b.y + 0.5);
      scene.add(g);
    });

    // ── Coins (instanced spinning cylinders) ───────────────────────────
    // Bright + emissive so they pop against the dark ground and read from a
    // distance. Slightly larger radius too.
    const coinGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.09, 16);
    const coinMat = new THREE.MeshStandardMaterial({
      color: 0xffe24a, metalness: 0.6, roughness: 0.2,
      emissive: 0xffc400, emissiveIntensity: 0.9,
    });
    const coinCount = st.world.coins.length;
    const coinsMesh = new THREE.InstancedMesh(coinGeo, coinMat, coinCount);
    scene.add(coinsMesh);
    // A soft glow billboard under each coin so they're visible from afar.
    const glowTexCvs = document.createElement("canvas");
    glowTexCvs.width = 64; glowTexCvs.height = 64;
    const gx = glowTexCvs.getContext("2d")!;
    const grad = gx.createRadialGradient(32, 32, 2, 32, 32, 30);
    grad.addColorStop(0, "rgba(255,220,90,0.85)");
    grad.addColorStop(0.5, "rgba(255,200,60,0.35)");
    grad.addColorStop(1, "rgba(255,200,60,0)");
    gx.fillStyle = grad; gx.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(glowTexCvs);
    const coinGlows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.1, 1.1),
      new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      coinCount,
    );
    scene.add(coinGlows);
    // Dropped-coin pool (death loot) — same bright look, larger.
    const DROP_POOL = 48;
    const dropsMesh = new THREE.InstancedMesh(coinGeo, coinMat.clone(), DROP_POOL);
    (dropsMesh.material as THREE.MeshStandardMaterial).emissive = new THREE.Color(0xff8800);
    (dropsMesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.0;
    scene.add(dropsMesh);

    // ── Players: blob spheres (bots) / billboard sprite (human) ────────
    const playerGroups: THREE.Group[] = [];
    const bodyMats: THREE.MeshStandardMaterial[] = [];
    const humanSprites: (THREE.Sprite | null)[] = [];
    const invRings: THREE.Mesh[] = [];
    const slowAuras: THREE.Mesh[] = [];
    const atkArcs: THREE.Mesh[] = [];
    const atkArcMats: THREE.MeshBasicMaterial[] = [];

    st.players.forEach((p, i) => {
      const g = new THREE.Group();
      // Blob body
      const mat = new THREE.MeshStandardMaterial({ color: PLAYER_COLORS[i], roughness: 0.55, emissive: 0x000000 });
      bodyMats.push(mat);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.55, 24, 18), mat);
      body.position.y = 0.55;
      body.name = "body";
      g.add(body);
      // Eyes (front-facing; the group yaws toward facing so they look alive)
      const eyeGeo = new THREE.SphereGeometry(0.09, 10, 8);
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const pupilGeo = new THREE.SphereGeometry(0.045, 8, 6);
      const pupilMat = new THREE.MeshBasicMaterial({ color: 0x101418 });
      for (const sx of [-0.18, 0.18]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(sx, 0.68, 0.45);
        eye.name = "eye";
        g.add(eye);
        const pupil = new THREE.Mesh(pupilGeo, pupilMat);
        pupil.position.set(sx, 0.68, 0.53);
        pupil.name = "eye";
        g.add(pupil);
      }
      // Blob shadow (cheap, readable)
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.55, 18),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.012;
      g.add(shadow);
      // Invincibility ring
      const inv = new THREE.Mesh(
        new THREE.TorusGeometry(0.8, 0.035, 8, 28),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 }),
      );
      inv.rotation.x = -Math.PI / 2;
      inv.position.y = 0.1;
      g.add(inv);
      invRings.push(inv);
      // Slow aura
      const aura = new THREE.Mesh(
        new THREE.CircleGeometry(0.85, 20),
        new THREE.MeshBasicMaterial({ color: 0x78dc8c, transparent: true, opacity: 0 }),
      );
      aura.rotation.x = -Math.PI / 2;
      aura.position.y = 0.02;
      g.add(aura);
      slowAuras.push(aura);
      // Attack swing arc (flat wedge in front, flashes on swing)
      const arcMat = new THREE.MeshBasicMaterial({ color: 0xfff0e0, transparent: true, opacity: 0, side: THREE.DoubleSide });
      atkArcMats.push(arcMat);
      const arc = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.25, 14, 1, -0.65, 1.3), arcMat);
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = 0.2;
      arc.name = "arc";
      g.add(arc);
      atkArcs.push(arc);
      // Human billboard sprite (created lazily when skin texture is ready)
      humanSprites.push(null);
      scene.add(g);
      playerGroups.push(g);
    });

    let appliedSkinVersion = -1;
    function syncHumanSprite() {
      if (appliedSkinVersion === skinVersionRef.current) return;
      const img = skinImgRef.current;
      const g = playerGroups[HUMAN];
      // Remove old sprite if any.
      const old = humanSprites[HUMAN];
      if (old) { g.remove(old); (old.material as THREE.SpriteMaterial).map?.dispose(); old.material.dispose(); humanSprites[HUMAN] = null; }
      const showSphere = !(img && img.complete && img.naturalWidth > 0);
      g.children.forEach(ch => {
        if (ch.name === "body" || ch.name === "eye") ch.visible = showSphere;
      });
      if (!showSphere && img) {
        const tex = new THREE.Texture(img);
        tex.needsUpdate = true;
        if ("colorSpace" in tex && (THREE as any).SRGBColorSpace) (tex as any).colorSpace = (THREE as any).SRGBColorSpace;
        const sm = new THREE.SpriteMaterial({ map: tex, transparent: true });
        const spr = new THREE.Sprite(sm);
        spr.scale.set(2.3, 2.3, 1);
        spr.position.y = 1.05;
        g.add(spr);
        humanSprites[HUMAN] = spr;
      }
      appliedSkinVersion = skinVersionRef.current;
    }

    // ── Slime projectiles + traps (pools) ──────────────────────────────
    const PROJ_POOL = 16;
    const projMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < PROJ_POOL; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 12, 10),
        new THREE.MeshStandardMaterial({ color: 0x8ef0a8, emissive: 0x2a7a3a, roughness: 0.3 }),
      );
      m.visible = false;
      scene.add(m);
      projMeshes.push(m);
    }
    const TRAP_POOL = 24;
    const trapMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < TRAP_POOL; i++) {
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(0.48, 16),
        new THREE.MeshBasicMaterial({ color: 0x78dc8c, transparent: true, opacity: 0.45 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = 0.03;
      m.visible = false;
      scene.add(m);
      trapMeshes.push(m);
    }

    // ── Particles (pickup / bank bursts) ───────────────────────────────
    const PART_POOL = 60;
    const particles: Particle[] = [];
    const partGeo = new THREE.SphereGeometry(0.07, 6, 5);
    for (let i = 0; i < PART_POOL; i++) {
      const m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 1 }));
      m.visible = false;
      scene.add(m);
      particles.push({ mesh: m, vx: 0, vy: 0, vz: 0, life: 0, active: false });
    }
    function burst(x: number, z: number, color: number, n: number) {
      let spawned = 0;
      for (const p of particles) {
        if (spawned >= n) break;
        if (p.active) continue;
        p.active = true;
        p.mesh.visible = true;
        (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
        p.mesh.position.set(x, 0.5, z);
        const a = Math.random() * Math.PI * 2;
        const sp = 1.2 + Math.random() * 1.6;
        p.vx = Math.cos(a) * sp * 0.5;
        p.vz = Math.sin(a) * sp * 0.5;
        p.vy = 2.2 + Math.random() * 1.4;
        p.life = 0.55 + Math.random() * 0.2;
        spawned++;
      }
    }

    // ── Per-player anim state + event diffing ──────────────────────────
    const anim: AnimState[] = st.players.map(p => ({
      prevX: p.x, prevY: p.y, curX: p.x, curY: p.y,
      dmgT: 0, atkT: 0, deathT: 0,
      lastHealth: p.health, lastAttackReady: p.attackReadyTick,
      lastCarried: p.carried, lastBanked: p.banked, lastAlive: p.alive,
      yaw: 0,
    }));
    let vignetteT = 0;          // human damage screen flash
    let ghostHealth = START_HEALTH;
    let ghostDelay = 0;
    let barShakeT = 0;

    // ── Input (human) ──────────────────────────────────────────────────
    const HOLD_MS = 180;
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      keysRef.current.add(k);
      if (k === "l" && lKeyDownAtRef.current === 0) lKeyDownAtRef.current = performance.now();
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
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
      let dir = keysToDir(keys);
      // Touch joystick overrides/augments keyboard when active.
      const tm = touchMoveRef.current;
      if (tm.active && (tm.x !== 0 || tm.y !== 0)) {
        // Convert joystick vector to one of 8 directions (deadzone applied by caller).
        const dx = Math.abs(tm.x) < 0.35 ? 0 : Math.sign(tm.x);
        const dy = Math.abs(tm.y) < 0.35 ? 0 : Math.sign(tm.y);
        if (dx !== 0 || dy !== 0) {
          for (let i = 0; i < 8; i++) if (DIR8[i].dx === dx && DIR8[i].dy === dy) { dir = i; break; }
        }
      }
      const attack = keys.has("j") || touchAttackRef.current;
      const steal = keys.has("k") || touchStealRef.current;
      const slime = slimeActionRef.current;
      slimeActionRef.current = SLIME_NONE;
      return packInput(dir, attack, steal, slime);
    }

    // ── Main loop ──────────────────────────────────────────────────────
    let acc = 0;
    let last = performance.now();
    let lastHudCarried = -1, lastHudBanked = -1, lastHudSecs = -1;
    const camTarget = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    // Prime camera at the human spawn so the first frame isn't from origin.
    {
      const hp = st.players[HUMAN];
      camTarget.set(hp.x / FP_ONE, 0, hp.y / FP_ONE);
      camera.position.copy(camTarget).add(CAM_OFFSET);
      camera.lookAt(camTarget);
    }

    function stepSim() {
      // Record prev positions for interpolation.
      for (let i = 0; i < st.players.length; i++) {
        anim[i].prevX = st.players[i].x;
        anim[i].prevY = st.players[i].y;
      }
      const inputs = st.players.map((p, i) => (i === HUMAN ? humanInput() : botInput(st, p)));
      tick(st, inputs);
      // Diff state -> fire visual events.
      for (let i = 0; i < st.players.length; i++) {
        const p = st.players[i];
        const a = anim[i];
        a.curX = p.x; a.curY = p.y;
        if (p.health < a.lastHealth && p.alive) {
          a.dmgT = 1;
          if (i === HUMAN) { vignetteT = 1; barShakeT = 1; ghostDelay = 0.4; }
        }
        if (i === HUMAN && p.health !== a.lastHealth) {
          // Snap fill instantly; ghost catches up after a delay.
          if (healthFillRef.current) healthFillRef.current.style.width = `${(p.health / START_HEALTH) * 100}%`;
        }
        if (p.attackReadyTick !== a.lastAttackReady) a.atkT = 1;
        if (!p.alive && a.lastAlive) { a.deathT = 1; if (i === HUMAN) { vignetteT = 1; } }
        if (p.alive && !a.lastAlive && i === HUMAN) {
          ghostHealth = p.health;
          if (healthFillRef.current) healthFillRef.current.style.width = "100%";
          if (healthGhostRef.current) healthGhostRef.current.style.width = "100%";
        }
        if (p.carried > a.lastCarried) burst(p.x / FP_ONE, p.y / FP_ONE, 0xffd24a, 5);
        if (p.banked > a.lastBanked) {
          const b = st.world.bases[i];
          burst(b.x + 0.5, b.y + 0.5, 0x6ef08a, 8);
        }
        a.lastHealth = p.health;
        a.lastAttackReady = p.attackReadyTick;
        a.lastCarried = p.carried;
        a.lastBanked = p.banked;
        a.lastAlive = p.alive;
      }
    }

    function loop(now: number) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      acc += dt * 1000;
      const tickMs = 1000 / TICKS_PER_SEC;
      while (acc >= tickMs && st.tick < GAMEPLAY_TICKS) {
        stepSim();
        acc -= tickMs;
      }
      const alpha = Math.min(1, acc / tickMs);

      syncHumanSprite();

      // ── Animate players ──
      for (let i = 0; i < st.players.length; i++) {
        const p = st.players[i];
        const a = anim[i];
        const g = playerGroups[i];
        const wx = (a.prevX + (a.curX - a.prevX) * alpha) / FP_ONE;
        const wz = (a.prevY + (a.curY - a.prevY) * alpha) / FP_ONE;
        const moving = Math.abs(a.curX - a.prevX) + Math.abs(a.curY - a.prevY) > 0;
        // Bob + squash while moving; idle breathe otherwise.
        const t = now / 1000;
        const bob = moving ? Math.abs(Math.sin(t * 9 + i)) * 0.10 : Math.sin(t * 2 + i) * 0.03;
        g.position.set(wx, bob, wz);
        // Yaw toward facing (eyes/arc orientation). Lerp shortest way.
        const targetYaw = Math.atan2(DIR8[p.facing].dx, DIR8[p.facing].dy);
        let dy = targetYaw - a.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        a.yaw += dy * Math.min(1, dt * 14);
        g.rotation.y = a.yaw;
        // Squash/stretch
        const squash = moving ? 1 + Math.sin(t * 18 + i) * 0.06 : 1;
        // Death shrink / respawn pop
        let scale = 1;
        if (!p.alive) {
          a.deathT = Math.max(0, a.deathT - dt * 2.6);
          scale = a.deathT; // shrinks to 0, stays 0 while dead
        } else if (a.deathT > 0) {
          a.deathT = 0;
        }
        g.scale.set(scale, scale * squash, scale);
        g.visible = scale > 0.01;

        // Damage pulse: red emissive flash on body; sprite gets a color tint.
        a.dmgT = Math.max(0, a.dmgT - dt * 3.2);
        const dm = a.dmgT * a.dmgT;
        bodyMats[i].emissive.setRGB(dm * 0.9, dm * 0.05, dm * 0.05);
        const spr = humanSprites[i];
        if (spr) {
          (spr.material as THREE.SpriteMaterial).color.setRGB(1, 1 - dm * 0.75, 1 - dm * 0.75);
        }

        // Attack arc flash
        a.atkT = Math.max(0, a.atkT - dt * 6);
        atkArcMats[i].opacity = a.atkT * 0.85;
        atkArcs[i].scale.setScalar(1 + (1 - a.atkT) * 0.35);

        // Invincibility ring + slow aura
        const inv = st.tick < p.invincibleUntilTick;
        (invRings[i].material as THREE.MeshBasicMaterial).opacity = inv ? 0.55 + Math.sin(t * 10) * 0.25 : 0;
        const slowed = st.tick < p.slowedUntilTick;
        (slowAuras[i].material as THREE.MeshBasicMaterial).opacity = slowed ? 0.35 + Math.sin(t * 8) * 0.12 : 0;
      }

      // ── Coins ──
      const spin = now / 400;
      const flatGlow = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
      for (let c = 0; c < coinCount; c++) {
        const coin = st.world.coins[c];
        if (coin.taken) {
          tmpM.makeScale(0, 0, 0);
          coinsMesh.setMatrixAt(c, tmpM);
          coinGlows.setMatrixAt(c, tmpM);
        } else {
          tmpM.makeRotationY(spin + c * 0.4);
          // Stand the cylinder on edge so it reads as a coin, then float-bob.
          const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2);
          tmpM.multiply(rot);
          const by = 0.5 + Math.sin(spin * 2 + c) * 0.07;
          tmpM.setPosition(coin.x + 0.5, by, coin.y + 0.5);
          coinsMesh.setMatrixAt(c, tmpM);
          // Glow: flat on ground, gentle pulse.
          const gs = 1 + Math.sin(spin * 3 + c) * 0.15;
          const gm = flatGlow.clone();
          gm.scale(new THREE.Vector3(gs, gs, gs));
          gm.setPosition(coin.x + 0.5, 0.06, coin.y + 0.5);
          coinGlows.setMatrixAt(c, gm);
        }
      }
      coinsMesh.instanceMatrix.needsUpdate = true;
      coinGlows.instanceMatrix.needsUpdate = true;
      for (let d = 0; d < DROP_POOL; d++) {
        const dc = st.droppedCoins[d];
        if (dc && dc.amount > 0) {
          tmpM.makeRotationY(spin * 1.4 + d);
          const rot = new THREE.Matrix4().makeRotationX(Math.PI / 2);
          tmpM.multiply(rot);
          const s = Math.min(1.7, 1 + dc.amount * 0.08);
          tmpM.scale(new THREE.Vector3(s, s, s));
          tmpM.setPosition(dc.tx + 0.5, 0.45, dc.ty + 0.5);
        } else {
          tmpM.makeScale(0, 0, 0);
        }
        dropsMesh.setMatrixAt(d, tmpM);
      }
      dropsMesh.instanceMatrix.needsUpdate = true;

      // ── Projectiles + traps ──
      for (let i = 0; i < PROJ_POOL; i++) {
        const pr = st.projectiles[i];
        if (pr) {
          projMeshes[i].visible = true;
          projMeshes[i].position.set(pr.x / FP_ONE, 0.45 + Math.sin(now / 60) * 0.04, pr.y / FP_ONE);
        } else projMeshes[i].visible = false;
      }
      for (let i = 0; i < TRAP_POOL; i++) {
        const tr = st.traps[i];
        if (tr) {
          trapMeshes[i].visible = true;
          trapMeshes[i].position.set(tr.tx + 0.5, 0.03, tr.ty + 0.5);
          (trapMeshes[i].material as THREE.MeshBasicMaterial).opacity = 0.3 + Math.sin(now / 180 + i) * 0.15;
        } else trapMeshes[i].visible = false;
      }

      // ── Particles ──
      for (const p of particles) {
        if (!p.active) continue;
        p.life -= dt;
        if (p.life <= 0) { p.active = false; p.mesh.visible = false; continue; }
        p.vy -= 7.5 * dt;
        p.mesh.position.x += p.vx * dt;
        p.mesh.position.y += p.vy * dt;
        p.mesh.position.z += p.vz * dt;
        if (p.mesh.position.y < 0.05) { p.mesh.position.y = 0.05; p.vy *= -0.4; }
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, p.life * 2.5);
      }

      // ── Camera follow ──
      const hp = playerGroups[HUMAN].position;
      camTarget.lerp(new THREE.Vector3(hp.x, 0, hp.z), Math.min(1, dt * 6));
      camera.position.copy(camTarget).add(CAM_OFFSET);
      lookTarget.set(camTarget.x, 0.6, camTarget.z);
      camera.lookAt(lookTarget);

      // ── DOM overlays (direct mutation, no React) ──
      // Health ghost bar (fighting-game style trailing damage)
      const meHealth = st.players[HUMAN].health;
      if (ghostDelay > 0) ghostDelay -= dt;
      else if (ghostHealth > meHealth) {
        ghostHealth = Math.max(meHealth, ghostHealth - dt * 60);
        if (healthGhostRef.current) healthGhostRef.current.style.width = `${(ghostHealth / START_HEALTH) * 100}%`;
      }
      if (ghostHealth < meHealth) {
        ghostHealth = meHealth;
        if (healthGhostRef.current) healthGhostRef.current.style.width = `${(ghostHealth / START_HEALTH) * 100}%`;
      }
      // Bar shake
      barShakeT = Math.max(0, barShakeT - dt * 4);
      if (healthWrapRef.current) {
        const sh = barShakeT > 0 ? Math.sin(now / 14) * barShakeT * 5 : 0;
        healthWrapRef.current.style.transform = `translateX(${sh}px)`;
      }
      // Damage vignette
      vignetteT = Math.max(0, vignetteT - dt * 2.2);
      if (vignetteRef.current) vignetteRef.current.style.opacity = String(vignetteT * 0.75);

      // HOME edge arrow: project base to screen; clamp to edge if off-view.
      if (homeArrowRef.current) {
        const b = st.world.bases[HUMAN];
        const v = new THREE.Vector3(b.x + 0.5, 0.4, b.y + 0.5).project(camera);
        const off = Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1;
        if (off) {
          const cl = Math.max(0.001, Math.max(Math.abs(v.x), Math.abs(v.y)));
          const ex = (v.x / cl) * 0.92, ey = (v.y / cl) * 0.92;
          const { w: cw, h: ch } = sizeRef.current;
          const px = (ex * 0.5 + 0.5) * cw;
          const py = (-ey * 0.5 + 0.5) * ch;
          const ang = Math.atan2(-ey, ex);
          homeArrowRef.current.style.display = "block";
          homeArrowRef.current.style.left = `${px}px`;
          homeArrowRef.current.style.top = `${py}px`;
          homeArrowRef.current.style.transform = `translate(-50%,-50%) rotate(${ang}rad)`;
        } else {
          homeArrowRef.current.style.display = "none";
        }
      }

      // HUD numbers (state only when changed; tick-rate at most)
      const me = st.players[HUMAN];
      const secsLeft = Math.max(0, Math.ceil((GAMEPLAY_TICKS - st.tick) / TICKS_PER_SEC));
      if (me.carried !== lastHudCarried || me.banked !== lastHudBanked || secsLeft !== lastHudSecs) {
        lastHudCarried = me.carried; lastHudBanked = me.banked; lastHudSecs = secsLeft;
        setHud({ carried: me.carried, banked: me.banked, secsLeft });
      }

      renderer.render(scene, camera);

      if (st.tick >= GAMEPLAY_TICKS) {
        running = false;
        setStatus("finished");
        setFinalStandings(
          st.players.map(p => ({ idx: p.idx, score: finalScore(p) })).sort((a, b) => b.score - a.score),
        );
        return;
      }
      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    return () => {
      running = false;
      ro.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      renderer.dispose();
      scene.traverse(obj => {
        const m = obj as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = (m as any).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x: THREE.Material) => x.dispose());
      });
      groundTex.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [seed]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", width: "100%" }}>
      <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
        <div ref={mountRef} style={{ width: "100%" }} />

        {/* Health bar (top-left overlay) with ghost damage segment */}
        <div style={{ position: "absolute", top: 10, left: 12, width: isTouch ? 120 : 220 }}>
          <div style={{ fontSize: isTouch ? 8 : 10, color: "#cfe0f4", letterSpacing: "0.1em", marginBottom: 3 }}>HEALTH</div>
          <div ref={healthWrapRef} style={{ position: "relative", height: isTouch ? 9 : 14, background: "rgba(0,0,0,0.55)", borderRadius: 7, border: "1px solid rgba(255,255,255,0.18)", overflow: "hidden" }}>
            <div ref={healthGhostRef} style={{ position: "absolute", inset: 0, width: "100%", background: "#ffb1b1", borderRadius: 7, transition: "none" }} />
            <div ref={healthFillRef} style={{ position: "absolute", inset: 0, width: "100%", background: "linear-gradient(180deg,#7dff8e,#3ecf5a)", borderRadius: 7 }} />
          </div>
        </div>

        {/* Timer (top-center) */}
        <div style={{ position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", fontSize: 18, fontWeight: 700, color: hud.secsLeft <= 15 ? "#ff5c7a" : "#e8f4ff", textShadow: "0 1px 4px rgba(0,0,0,0.7)" }}>
          {hud.secsLeft}s
        </div>

        {/* Stash / bank (top-right) */}
        <div style={{ position: "absolute", top: 10, right: 12, textAlign: "right", fontSize: 13, color: "#cfe0f4", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>
          <div style={{ color: "#ffd24a" }}>● Stashed: <b>{hud.carried}</b></div>
          <div style={{ color: "#7dff8e" }}>▣ Banked: <b>{hud.banked}</b></div>
          <div>Score: <b>{hud.banked * COIN_SCORE}</b></div>
        </div>

        {/* Damage vignette */}
        <div ref={vignetteRef} style={{
          position: "absolute", inset: 0, pointerEvents: "none", opacity: 0, borderRadius: 8,
          background: "radial-gradient(ellipse at center, rgba(255,0,40,0) 52%, rgba(255,0,40,0.55) 100%)",
        }} />

        {/* HOME edge arrow */}
        <div ref={homeArrowRef} style={{ position: "absolute", display: "none", pointerEvents: "none", color: PLAYER_COLORS_CSS[HUMAN], fontSize: 22, fontWeight: 800, textShadow: "0 1px 4px rgba(0,0,0,0.8)" }}>
          ➤<span style={{ fontSize: 10, display: "block", transform: "rotate(0deg)", textAlign: "center" }}>HOME</span>
        </div>

        {/* Touch controls — mobile/tablet only */}
        {isTouch && (
          <TouchControls
            moveRef={touchMoveRef}
            attackRef={touchAttackRef}
            stealRef={touchStealRef}
            slimeActionRef={slimeActionRef}
            lDownRef={lKeyDownAtRef}
          />
        )}

        {/* End screen */}
        {status === "finished" && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(8,11,18,0.88)", borderRadius: 8,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#e8f4ff" }}>
              {finalStandings[0]?.idx === HUMAN ? "You win the lobby! 🏆" : `Lobby winner: P${finalStandings[0]?.idx}`}
            </div>
            {finalStandings.slice(0, 5).map((s, i) => (
              <div key={s.idx} style={{ fontSize: 12, color: s.idx === HUMAN ? "#ffd24a" : PLAYER_COLORS_CSS[s.idx] }}>
                #{i + 1} {s.idx === HUMAN ? "YOU" : `P${s.idx}`}: {s.score}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ fontSize: 11, color: "#7c8aa3", textAlign: "center", lineHeight: 1.6 }}>
        {isTouch ? (
          <>Joystick to move · <b>ATK</b> attack (0.53s cooldown) · <b>STEAL</b> on enemy base · <b>SLIME</b> tap = throw, hold = drop<br />
          Bank coins at your <span style={{ color: PLAYER_COLORS_CSS[HUMAN] }}>home base</span> (follow the ➤ HOME arrow). Banked coins score; stashed don't.</>
        ) : (
          <><b>WASD / arrows</b> move · <b>J</b> attack (0.53s cooldown) · <b>K</b> steal (on enemy base) · <b>L</b> tap = throw slime, hold = drop trap<br />
          Bank coins at your <span style={{ color: PLAYER_COLORS_CSS[HUMAN] }}>home base</span> (follow the ➤ HOME arrow). Banked coins score; stashed coins don't.</>
        )}
      </div>
    </div>
  );
}