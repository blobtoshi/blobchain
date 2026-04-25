// Standalone copy of src/lib/blob/simulator.ts for the Deno edge runtime.
// Keep BYTE-FOR-BYTE in sync with the client copy. ENGINE_VERSION must match.

export const ENGINE_VERSION = 2;
export const MAX_FRAMES = 36000;
export const MAX_INPUTS_PER_RUN = MAX_FRAMES;

const GY = 290;
const PX = 130;
const GRAVITY = 0.66;
const JUMP_V = -14.5;
const TYMAP = { low: GY - 52, mid: GY - 94, high: GY - 140 };

function mkPrng(seed: number) {
  let s = (Math.abs(+seed) * 2654435761) >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateLevelPure(seed: number) {
  const rng = mkPrng(seed);
  const obstacles: any[] = [];
  const tokens: any[] = [];
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

function initialState() {
  return {
    frame: 0, score: 0, dist: 0, speed: 4.5, locked: false,
    combo: 0, comboTimer: 0, obsIdx: 0, tokIdx: 0,
    player: { y: GY - 28, vy: 0, action: "run", wob: 0, sq: 1 },
    obstacles: [] as any[], tokens: [] as any[],
    jumpHeld: false, duckHeld: false, dead: false,
    passedFirstObstacle: false,
  };
}

function applyInputs(state: any, events: any[]) {
  for (const e of events) {
    if (e.t === 0) state.jumpHeld = true;
    else if (e.t === 1) state.jumpHeld = false;
    else if (e.t === 2) state.duckHeld = true;
    else if (e.t === 3) state.duckHeld = false;
  }
}

function tick(state: any, level: any, frameInputs: any[]) {
  if (state.dead) return false;
  applyInputs(state, frameInputs);
  const p = state.player;
  state.frame++;

  if (state.jumpHeld && p.action !== "jump") { p.vy = JUMP_V; p.action = "jump"; }
  if (!state.jumpHeld && state.duckHeld && p.action !== "jump") p.action = "duck";
  else if (!state.duckHeld && p.action === "duck") p.action = "run";
  p.vy += GRAVITY;
  p.y += p.vy;
  const fl = p.action === "duck" ? GY - 16 : GY - 28;
  if (p.y >= fl) {
    if (p.vy > 5) p.sq = 0.5;
    p.y = fl; p.vy = 0;
    if (p.action === "jump") p.action = "run";
  }
  p.sq += (1 - p.sq) * 0.13;
  p.wob++;
  if (!state.locked) {
    if (state.passedFirstObstacle) state.score++;
    state.dist += state.speed;
    state.speed = 4.5 + Math.pow(state.score / 600, 1.15) * 0.9;
  }
  if (!state.passedFirstObstacle) {
    for (const o of state.obstacles) {
      if (o.x + o.w < PX) { state.passedFirstObstacle = true; break; }
    }
  }
  if (state.comboTimer > 0 && --state.comboTimer === 0) state.combo = 0;

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
    state.tokens.push({ x: 780 + 8, y: TYMAP[ev.height as keyof typeof TYMAP], alive: true });
  }

  for (const o of state.obstacles) o.x -= state.speed;
  state.obstacles = state.obstacles.filter((o: any) => o.x > -70);
  for (const t of state.tokens) t.x -= state.speed;
  state.tokens = state.tokens.filter((t: any) => t.x > -35);

  const dk = p.action === "duck";
  const ph = dk ? 22 : 42;
  const pw = dk ? 46 : 30;
  const x1 = PX - pw / 2 + 4, x2 = PX + pw / 2 - 4;
  const y1 = p.y - ph / 2 + 4, y2 = p.y + ph / 2 - 4;
  for (const o of state.obstacles) {
    if (x2 > o.x + 4 && x1 < o.x + o.w - 4 && y2 > o.y + 4 && y1 < o.y + o.h - 4) {
      state.dead = true; state.locked = true;
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

export function parseCanonicalInputs(canonical: string) {
  if (!canonical) return [];
  return canonical.split(",").map(tok => {
    const [f, t] = tok.split(":");
    return { f: Number(f), t: Number(t) };
  });
}

export function plausibilityCheck(events: any[], frameCount: number, claimedScore: number) {
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > MAX_FRAMES)
    return "frame_count out of range";
  if (events.length > MAX_INPUTS_PER_RUN) return "too many inputs";
  if (events.length > Math.ceil(frameCount * 0.5) + 20) return "implausible input cadence";
  if (claimedScore > frameCount * 3 + 500) return "score exceeds physical maximum";
  let last = -1;
  for (const e of events) {
    if (typeof e.f !== "number" || typeof e.t !== "number" || Number.isNaN(e.f) || Number.isNaN(e.t))
      return "malformed event";
    if (!Number.isInteger(e.f) || e.f < 1 || e.f > frameCount) return "event frame out of range";
    if (e.f < last) return "events not sorted";
    if (!Number.isInteger(e.t) || e.t < 0 || e.t > 3) return "bad event type";
    last = e.f;
  }
  return null;
}

export function simulate(seed: number, events: any[], frameCount: number) {
  const level = generateLevelPure(seed);
  const state = initialState();
  const buckets = new Map<number, any[]>();
  for (const e of events) {
    if (!buckets.has(e.f)) buckets.set(e.f, []);
    buckets.get(e.f)!.push(e);
  }
  const target = Math.min(frameCount, MAX_FRAMES);
  for (let f = 0; f < target; f++) {
    const evs = buckets.get(f + 1) || [];
    const alive = tick(state, level, evs);
    if (!alive) break;
  }
  return { score: state.score, frame: state.frame, dead: state.dead };
}
