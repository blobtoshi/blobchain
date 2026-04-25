// Pure, deterministic Blob Run physics simulator.
// SAME module is imported by the React canvas component AND the
// submit-entry edge function. Any drift = consensus break, so do not
// change the constants or tick math without bumping ENGINE_VERSION.

import { mkPrng, getRewardForHeight } from "./chain";
import { GY, PX, GRAVITY, JUMP_V } from "./constants";

export const ENGINE_VERSION = 2;

// Maximum number of simulated frames we will replay. ~60 fps * 600 s = 36000.
// A run that lasts longer than this is rejected (would otherwise enable a
// "trickle inputs forever" DoS on the verifier).
export const MAX_FRAMES = 36000;

// Maximum input events. A human realistically issues <8 events/sec; we cap
// at an extremely generous 30/sec averaged across the whole run.
export const MAX_INPUTS_PER_RUN = MAX_FRAMES; // hard ceiling; cadence checked too

// TYMAP duplicated here to keep this module standalone (level.ts pulls in
// canvas/Image which can't run in Deno).
const TYMAP = { low: GY - 52, mid: GY - 94, high: GY - 140 };

// Mirror of generateLevel() from level.ts but without sprite imports.
export function generateLevelPure(seed) {
  const rng = mkPrng(seed);
  const obstacles = [];
  const tokens = [];
  let pos = 250;
  let idx = 0;
  while (pos < 400000) {
    const tightness = Math.min(idx / 120, 1);
    const baseMin = 240 - tightness * 130;
    const baseRng = 280 - tightness * 200;
    const gap = baseMin + rng() * baseRng;
    pos += gap;
    idx++;
    const r = rng();
    if (r < 0.38) obstacles.push({ at: pos, type: "fork", w: 36, h: 66 });
    else if (r < 0.6) obstacles.push({ at: pos, type: "double", w: 36, h: 66 });
    else if (r < 0.75) obstacles.push({ at: pos, type: "tall", w: 40, h: 90 });
    else obstacles.push({ at: pos, type: "low", w: 60, h: 18 });
    if (rng() < 0.68) {
      const hs = ["low", "mid", "high"];
      tokens.push({ at: pos - gap * 0.4, height: hs[Math.floor(rng() * 3)] });
    }
  }
  return { obstacles, tokens };
}

// ---------- Input trace -------------------------------------------------
// An InputEvent is { f: frame number, t: 0|1|2|3 }
// 0 = jump press, 1 = jump release, 2 = duck press, 3 = duck release
// Encoded canonically as "f:t,f:t,..." for hashing.
export function encodeInputs(events) {
  // Stable sort by frame then type; reject duplicate exact entries.
  const sorted = [...events].sort((a, b) => a.f - b.f || a.t - b.t);
  return sorted.map(e => `${e.f}:${e.t}`).join(",");
}

export async function hashInputs(canonical) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------- Initial state --------------------------------------------------
export function initialState() {
  return {
    frame: 0,
    score: 0,
    dist: 0,
    speed: 4.5,
    locked: false,
    combo: 0,
    comboTimer: 0,
    obsIdx: 0,
    tokIdx: 0,
    player: { y: GY - 28, vy: 0, action: "run", wob: 0, sq: 1 },
    obstacles: [],
    tokens: [],
    jumpHeld: false,
    duckHeld: false,
    dead: false,
    passedFirstObstacle: false,
  };
}

// Apply input events scheduled for the CURRENT frame.
function applyInputs(state, events) {
  for (const e of events) {
    if (e.t === 0) state.jumpHeld = true;
    else if (e.t === 1) state.jumpHeld = false;
    else if (e.t === 2) state.duckHeld = true;
    else if (e.t === 3) state.duckHeld = false;
  }
}

// One physics tick. Mirrors the loop() body in BlobRunGame.tsx exactly.
// `level` is the precomputed { obstacles, tokens } for this seed.
// Returns true if the player is alive after the tick, false if the run ended.
export function tick(state, level, frameInputs) {
  if (state.dead) return false;
  applyInputs(state, frameInputs);

  const p = state.player;
  state.frame++;

  if (state.jumpHeld && p.action !== "jump") {
    p.vy = JUMP_V;
    p.action = "jump";
  }
  if (!state.jumpHeld && state.duckHeld && p.action !== "jump") p.action = "duck";
  else if (!state.duckHeld && p.action === "duck") p.action = "run";
  p.vy += GRAVITY;
  p.y += p.vy;
  const fl = p.action === "duck" ? GY - 16 : GY - 28;
  if (p.y >= fl) {
    if (p.vy > 5) p.sq = 0.5;
    p.y = fl;
    p.vy = 0;
    if (p.action === "jump") p.action = "run";
  }
  p.sq += (1 - p.sq) * 0.13;
  p.wob++;
  if (!state.locked) {
    if (state.passedFirstObstacle) state.score++;
    state.dist += state.speed;
    state.speed = 4.5 + Math.pow(state.score / 600, 1.15) * 0.9;
  }
  // Detect first-obstacle clearance: any spawned obstacle whose right edge has moved past the player.
  if (!state.passedFirstObstacle) {
    for (const o of state.obstacles) {
      if (o.x + o.w < PX) { state.passedFirstObstacle = true; break; }
    }
  }
  if (state.comboTimer > 0 && --state.comboTimer === 0) state.combo = 0;

  // Spawn obstacles/tokens
  while (state.obsIdx < level.obstacles.length && state.dist >= level.obstacles[state.obsIdx].at) {
    const ev = level.obstacles[state.obsIdx++];
    if (ev.type === "low") {
      state.obstacles.push({ x: 780 + 8, y: GY - 50, w: ev.w, h: ev.h, type: "low" });
    } else {
      const ey = ev.type === "tall" ? GY - 90 : GY - 66;
      state.obstacles.push({ x: 780 + 8, y: ey, w: ev.w, h: ev.h, type: ev.type });
      if (ev.type === "double") {
        state.obstacles.push({ x: 780 + 8 + 190, y: ey, w: ev.w, h: ev.h, type: ev.type });
      }
    }
  }
  while (state.tokIdx < level.tokens.length && state.dist >= level.tokens[state.tokIdx].at) {
    const ev = level.tokens[state.tokIdx++];
    state.tokens.push({ x: 780 + 8, y: TYMAP[ev.height], alive: true });
  }

  // Move
  for (const o of state.obstacles) o.x -= state.speed;
  state.obstacles = state.obstacles.filter(o => o.x > -70);
  for (const t of state.tokens) t.x -= state.speed;
  state.tokens = state.tokens.filter(t => t.x > -35);

  // Collisions
  const dk = p.action === "duck";
  const ph = dk ? 22 : 42;
  const pw = dk ? 46 : 30;
  const x1 = PX - pw / 2 + 4, x2 = PX + pw / 2 - 4;
  const y1 = p.y - ph / 2 + 4, y2 = p.y + ph / 2 - 4;
  for (const o of state.obstacles) {
    if (x2 > o.x + 4 && x1 < o.x + o.w - 4 && y2 > o.y + 4 && y1 < o.y + o.h - 4) {
      state.dead = true;
      state.locked = true;
      return false;
    }
  }
  for (const t of state.tokens) {
    if (t.alive && Math.abs(PX - t.x) < 28 && Math.abs(p.y - t.y) < 28) {
      t.alive = false;
      if (state.passedFirstObstacle) {
        state.combo = Math.min(state.combo + 1, 10);
        state.comboTimer = 150;
        state.score += Math.floor(50 * (1 + state.combo * 0.25));
      }
    }
  }
  return true;
}

// Replay a full input trace and return the deterministic score + frame count.
export function simulate(seed, events, frameCount) {
  const level = generateLevelPure(seed);
  const state = initialState();
  // Bucket events by frame for O(F + E) replay.
  const buckets = new Map();
  for (const e of events) {
    if (!buckets.has(e.f)) buckets.set(e.f, []);
    buckets.get(e.f).push(e);
  }
  const target = Math.min(frameCount, MAX_FRAMES);
  for (let f = 0; f < target; f++) {
    const evs = buckets.get(f + 1) || []; // events apply at the frame they were recorded (frame becomes f+1)
    const alive = tick(state, level, evs);
    if (!alive) break;
  }
  return { score: state.score, frame: state.frame, dead: state.dead };
}

// Cheap plausibility check before paying for a full replay.
export function plausibilityCheck(events, frameCount, claimedScore) {
  if (frameCount < 1 || frameCount > MAX_FRAMES) return "frame_count out of range";
  if (events.length > MAX_INPUTS_PER_RUN) return "too many inputs";
  // Cadence: max 30 events / second sustained over the whole run (60fps -> 0.5/frame)
  if (events.length > Math.ceil(frameCount * 0.5) + 20) return "implausible input cadence";
  // Score upper bound: 1 per frame + up to 137 per token (combo 10 = floor(50*3.5)=175 max)
  // and tokens spawn at most ~once per 110px. Generous ceiling: frames + frames * 2.
  if (claimedScore > frameCount * 3 + 500) return "score exceeds physical maximum";
  // Frames must be monotonic and within bounds.
  let last = -1;
  for (const e of events) {
    if (typeof e.f !== "number" || typeof e.t !== "number") return "malformed event";
    if (e.f < 1 || e.f > frameCount) return "event frame out of range";
    if (e.f < last) return "events not sorted";
    if (e.t < 0 || e.t > 3 || !Number.isInteger(e.t)) return "bad event type";
    last = e.f;
  }
  return null;
}
