// BlobClash — deterministic simulation engine (Phase 0).
//
// Pure integer / fixed-point. Given the same initial seed and the same
// per-tick input set applied in player-index order, every peer reaches a
// bit-identical state and therefore an identical state hash. This is the
// foundation the whole trust model rests on (see design doc §3, §7).
//
// NO FLOATS in any state-mutating path. The only float use is in world.ts
// generation (Math.cos for base ring placement, PRNG float->int), which runs
// once at init identically everywhere and produces integer outputs.

import {
  FP_ONE, fpMul, fpFromInt, fpToTile,
  MAP_TILES, TILE_WALL, TILE_BASE,
  MOVE_SPEED_FP, MOVE_SPEED_DIAG_FP, DIR8, MOVE_NONE,
  START_HEALTH, HIT_DAMAGE, KILL_SCORE, COIN_SCORE,
  ATTACK_RANGE_TILES, ATTACK_COOLDOWN_TICKS, STEAL_PER_TICK, BASE_RADIUS,
  RESPAWN_DELAY_TICKS, INVINCIBLE_TICKS,
  SLIME_MAX_PER_GAME, SLIME_COOLDOWN_TICKS, SLIME_SLOW_TICKS,
  SLIME_SLOW_NUM, SLIME_SLOW_DEN, SLIME_TRAP_LIFETIME_TICKS,
  SLIME_PROJ_RANGE_TILES, SLIME_PROJ_SPEED_FP,
  SLIME_NONE, SLIME_THROW, SLIME_DROP,
  unpackInput,
} from "./constants";
import { generateWorld, tileAt, type ClashWorld } from "./world";

export type ClashPlayer = {
  idx: number;
  // Position in fixed-point (16.16). Tile = pos >> 16.
  x: number; y: number;
  facing: number;          // 0..7
  health: number;
  carried: number;         // coins held, not yet banked
  banked: number;          // coins banked at own base
  kills: number;
  alive: boolean;
  respawnAtTick: number;   // when dead, the tick at which we respawn
  invincibleUntilTick: number;
  slimesLeft: number;
  slimeReadyTick: number;  // earliest tick slime can be used again
  attackReadyTick: number; // earliest tick the next attack can fire (rate limit)
  slowedUntilTick: number;
  connected: boolean;      // false = disconnected (treated as no-op input)
};

export type SlimeProjectile = {
  x: number; y: number;    // fixed-point
  dir: number;             // 0..7
  ownerIdx: number;
  travelledFp: number;     // accumulated distance in fixed-point
};
export type SlimeTrap = {
  tx: number; ty: number;  // tile coords
  ownerIdx: number;
  expiresAtTick: number;
};

export type ClashState = {
  tick: number;
  world: ClashWorld;
  players: ClashPlayer[];
  projectiles: SlimeProjectile[];
  traps: SlimeTrap[];
  // Coins dropped on death (separate from the world's initial coin layout).
  // {tx,ty,amount}. Initial coins live in world.coins; these are death drops.
  droppedCoins: { tx: number; ty: number; amount: number }[];
};

export function initState(seed: number, playerCount: number): ClashState {
  const world = generateWorld(seed);
  const players: ClashPlayer[] = [];
  for (let i = 0; i < playerCount; i++) {
    const base = world.bases[i];
    players.push({
      idx: i,
      x: fpFromInt(base.x) + (FP_ONE >> 1),
      y: fpFromInt(base.y) + (FP_ONE >> 1),
      facing: 4, // S
      health: START_HEALTH,
      carried: 0, banked: 0, kills: 0,
      alive: true,
      respawnAtTick: -1,
      invincibleUntilTick: INVINCIBLE_TICKS, // brief spawn protection at game start
      slimesLeft: SLIME_MAX_PER_GAME,
      slimeReadyTick: 0,
      attackReadyTick: 0,
      slowedUntilTick: 0,
      connected: true,
    });
  }
  return { tick: 0, world, players, projectiles: [], traps: [], droppedCoins: [] };
}

// Resolve a single tick. `inputs` is an array indexed by player idx, each a
// packed input integer (or MOVE_NONE-equivalent 0 for disconnected/no-op).
// Mutates state in place. ALL iteration is in player-index order for
// determinism.
export function tick(state: ClashState, inputs: number[]): void {
  const t = state.tick;
  const P = state.players;

  // ── 1. Respawns ──────────────────────────────────────────────────────
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive && p.respawnAtTick >= 0 && t >= p.respawnAtTick) {
      const base = state.world.bases[i];
      p.x = fpFromInt(base.x) + (FP_ONE >> 1);
      p.y = fpFromInt(base.y) + (FP_ONE >> 1);
      p.health = START_HEALTH;
      p.alive = true;
      p.respawnAtTick = -1;
      p.invincibleUntilTick = t + INVINCIBLE_TICKS;
      p.carried = 0; // dropped on death already
    }
  }

  // ── 2. Movement ──────────────────────────────────────────────────────
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive || !p.connected) continue;
    const inp = unpackInput(inputs[i] ?? 0);
    if (inp.moveDir !== MOVE_NONE && inp.moveDir >= 0 && inp.moveDir < 8) {
      p.facing = inp.moveDir;
      const d = DIR8[inp.moveDir];
      let speed = d.diag ? MOVE_SPEED_DIAG_FP : MOVE_SPEED_FP;
      // Slime slow: halve speed (integer num/den).
      if (t < p.slowedUntilTick) speed = Math.floor(speed * SLIME_SLOW_NUM / SLIME_SLOW_DEN);
      // Axis-separated movement w/ wall collision. Move X then Y.
      const nx = p.x + d.dx * speed;
      const ny = p.y + d.dy * speed;
      if (tileAt(state.world, fpToTile(nx), fpToTile(p.y)) !== TILE_WALL) p.x = nx;
      if (tileAt(state.world, fpToTile(p.x), fpToTile(ny)) !== TILE_WALL) p.y = ny;
    }
  }

  // ── 3. Coin pickup (initial coins + dropped coins) ───────────────────
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive) continue;
    const tx = fpToTile(p.x), ty = fpToTile(p.y);
    // Initial world coins.
    for (let c = 0; c < state.world.coins.length; c++) {
      const coin = state.world.coins[c];
      if (!coin.taken && coin.x === tx && coin.y === ty) {
        coin.taken = true;
        p.carried += 1;
      }
    }
    // Dropped coins.
    for (let c = 0; c < state.droppedCoins.length; c++) {
      const dc = state.droppedCoins[c];
      if (dc.amount > 0 && dc.tx === tx && dc.ty === ty) {
        p.carried += dc.amount;
        dc.amount = 0;
      }
    }
  }

  // ── 4. Banking (standing anywhere on OWN base footprint) ─────────────
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive) continue;
    const tx = fpToTile(p.x), ty = fpToTile(p.y);
    const base = state.world.bases[i];
    if (Math.abs(tx - base.x) <= BASE_RADIUS && Math.abs(ty - base.y) <= BASE_RADIUS && p.carried > 0) {
      p.banked += p.carried;
      p.carried = 0;
    }
  }

  // ── 5. Raiding (standing on ENEMY base, holding steal) ───────────────
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive || !p.connected) continue;
    const inp = unpackInput(inputs[i] ?? 0);
    if (!inp.steal) continue;
    const tx = fpToTile(p.x), ty = fpToTile(p.y);
    // Whose base footprint am I standing on?
    for (let j = 0; j < P.length; j++) {
      if (j === i) continue;
      const base = state.world.bases[j];
      if (Math.abs(tx - base.x) <= BASE_RADIUS && Math.abs(ty - base.y) <= BASE_RADIUS) {
        const owner = P[j];
        const take = Math.min(STEAL_PER_TICK, owner.banked);
        if (take > 0) {
          owner.banked -= take;
          p.carried += take;
        }
        // Stealing ends invincibility (can't steal under protection).
        if (t < p.invincibleUntilTick) p.invincibleUntilTick = t;
      }
    }
  }

  // ── 6. Attacks ───────────────────────────────────────────────────────
  // Collect damage first (so simultaneous attacks are order-independent in
  // effect), then apply. Application order by index for kill attribution.
  const damageTo: number[] = new Array(P.length).fill(0);
  const attackerOf: number[] = new Array(P.length).fill(-1);
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive || !p.connected) continue;
    const inp = unpackInput(inputs[i] ?? 0);
    if (!inp.attack) continue;
    // Rate limit: a swing only fires if the cooldown has elapsed. Holding
    // the attack key just swings at the cooldown cadence. A blocked (still
    // cooling) attack press does nothing - no cooldown consumed, no
    // invincibility break.
    if (t < p.attackReadyTick) continue;
    p.attackReadyTick = t + ATTACK_COOLDOWN_TICKS;
    // Attacking ends invincibility (only on a real swing).
    if (t < p.invincibleUntilTick) p.invincibleUntilTick = t;
    const fd = DIR8[p.facing];
    for (let j = 0; j < P.length; j++) {
      if (j === i) continue;
      const target = P[j];
      if (!target.alive) continue;
      if (t < target.invincibleUntilTick) continue; // invincible: no damage
      const dxTiles = fpToTile(target.x) - fpToTile(p.x);
      const dyTiles = fpToTile(target.y) - fpToTile(p.y);
      // Within range?
      if (Math.abs(dxTiles) > ATTACK_RANGE_TILES || Math.abs(dyTiles) > ATTACK_RANGE_TILES) continue;
      // Same tile always hits.
      if (dxTiles === 0 && dyTiles === 0) {
        damageTo[j] += HIT_DAMAGE;
        if (attackerOf[j] === -1) attackerOf[j] = i;
        continue;
      }
      // Forward CONE test (~90 deg total, half-angle 45 deg) so the hit lands
      // where the blob is visibly aiming - not a full 180 deg hemisphere which
      // felt like "attacking a direction I'm not facing". Integer-only to stay
      // deterministic: require cos^2(theta) >= 1/2, i.e. 2*dot^2 >= |fd|^2 *
      // |delta|^2, with dot > 0.
      const dot = fd.dx * dxTiles + fd.dy * dyTiles;
      if (dot <= 0) continue;
      const lenFd2 = fd.dx * fd.dx + fd.dy * fd.dy;
      const lenDl2 = dxTiles * dxTiles + dyTiles * dyTiles;
      if (2 * dot * dot < lenFd2 * lenDl2) continue;   // outside the 90 deg cone
    }
  }
  // Apply damage + deaths.
  for (let j = 0; j < P.length; j++) {
    if (damageTo[j] <= 0) continue;
    const target = P[j];
    if (!target.alive) continue;
    target.health -= damageTo[j];
    if (target.health <= 0) {
      target.health = 0;
      target.alive = false;
      target.respawnAtTick = t + RESPAWN_DELAY_TICKS;
      // Drop 100% carried at death tile.
      if (target.carried > 0) {
        const dtx = fpToTile(target.x), dty = fpToTile(target.y);
        const existing = state.droppedCoins.find(d => d.tx === dtx && d.ty === dty);
        if (existing) existing.amount += target.carried;
        else state.droppedCoins.push({ tx: dtx, ty: dty, amount: target.carried });
        target.carried = 0;
      }
      const killer = attackerOf[j];
      if (killer >= 0 && P[killer]) {
        P[killer].kills += 1;
      }
    }
  }

  // ── 7. Slime use (throw / drop) ──────────────────────────────────────
  for (let i = 0; i < P.length; i++) {
    const p = P[i];
    if (!p.alive || !p.connected) continue;
    const inp = unpackInput(inputs[i] ?? 0);
    if (inp.slime === SLIME_NONE) continue;
    if (p.slimesLeft <= 0 || t < p.slimeReadyTick) continue;
    if (inp.slime === SLIME_THROW) {
      state.projectiles.push({ x: p.x, y: p.y, dir: p.facing, ownerIdx: i, travelledFp: 0 });
      p.slimesLeft -= 1;
      p.slimeReadyTick = t + SLIME_COOLDOWN_TICKS;
    } else if (inp.slime === SLIME_DROP) {
      state.traps.push({ tx: fpToTile(p.x), ty: fpToTile(p.y), ownerIdx: i, expiresAtTick: t + SLIME_TRAP_LIFETIME_TICKS });
      p.slimesLeft -= 1;
      p.slimeReadyTick = t + SLIME_COOLDOWN_TICKS;
    }
  }

  // ── 8. Advance projectiles + check hits ──────────────────────────────
  const maxRangeFp = fpFromInt(SLIME_PROJ_RANGE_TILES);
  for (let k = state.projectiles.length - 1; k >= 0; k--) {
    const pr = state.projectiles[k];
    const d = DIR8[pr.dir];
    const step = d.diag ? Math.floor(SLIME_PROJ_SPEED_FP * 7071 / 10000) : SLIME_PROJ_SPEED_FP;
    pr.x += d.dx * step;
    pr.y += d.dy * step;
    pr.travelledFp += step;
    const ptx = fpToTile(pr.x), pty = fpToTile(pr.y);
    let consumed = false;
    // Wall stops it.
    if (tileAt(state.world, ptx, pty) === TILE_WALL) consumed = true;
    // Enemy hit.
    if (!consumed) {
      for (let j = 0; j < P.length; j++) {
        if (j === pr.ownerIdx) continue;
        const target = P[j];
        if (!target.alive) continue;
        if (t < target.invincibleUntilTick) continue;
        if (fpToTile(target.x) === ptx && fpToTile(target.y) === pty) {
          target.slowedUntilTick = t + SLIME_SLOW_TICKS;
          consumed = true;
          break;
        }
      }
    }
    if (consumed || pr.travelledFp >= maxRangeFp) {
      state.projectiles.splice(k, 1);
    }
  }

  // ── 9. Trap triggers + expiry ────────────────────────────────────────
  for (let k = state.traps.length - 1; k >= 0; k--) {
    const tr = state.traps[k];
    if (t >= tr.expiresAtTick) { state.traps.splice(k, 1); continue; }
    let triggered = false;
    for (let j = 0; j < P.length; j++) {
      if (j === tr.ownerIdx) continue;
      const target = P[j];
      if (!target.alive) continue;
      if (t < target.invincibleUntilTick) continue;
      if (fpToTile(target.x) === tr.tx && fpToTile(target.y) === tr.ty) {
        target.slowedUntilTick = t + SLIME_SLOW_TICKS;
        triggered = true;
        break;
      }
    }
    if (triggered) state.traps.splice(k, 1);
  }

  state.tick = t + 1;
}

export function finalScore(p: ClashPlayer): number {
  return p.banked * COIN_SCORE + p.kills * KILL_SCORE;
}

// Determine the lobby winner. Tiebreak: score, then kills, then lowest idx.
// (The "earliest to reach score" tiebreak from the design doc requires the
// tick log; for Phase 0 single-process we use kills-then-idx, which is a
// deterministic subset. Full tiebreak added with the certificate in Phase 2.)
export function lobbyWinner(state: ClashState): number {
  let best = 0;
  for (let i = 1; i < state.players.length; i++) {
    const a = state.players[i], b = state.players[best];
    const sa = finalScore(a), sb = finalScore(b);
    if (sa > sb || (sa === sb && a.kills > b.kills)) best = i;
  }
  return best;
}

// ── Deterministic state hash ──────────────────────────────────────────────
// Canonical serialization: fixed field order, integers only. FNV-1a 32-bit
// over the byte stream. In production we'd use sha256 for the signed
// checkpoint; FNV is fine for the Phase 0 cross-process equality gate and is
// fast enough to call every tick in tests.
export function hashState(state: ClashState): number {
  let h = 0x811c9dc5 >>> 0;
  const mix = (v: number) => {
    // Fold a 32-bit int in 4 bytes.
    v = v | 0;
    for (let b = 0; b < 4; b++) {
      h ^= (v >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  mix(state.tick);
  for (const p of state.players) {
    mix(p.x); mix(p.y); mix(p.facing); mix(p.health);
    mix(p.carried); mix(p.banked); mix(p.kills);
    mix(p.alive ? 1 : 0); mix(p.respawnAtTick);
    mix(p.invincibleUntilTick); mix(p.slimesLeft);
    mix(p.slimeReadyTick); mix(p.attackReadyTick); mix(p.slowedUntilTick);
  }
  // Coins: only the count of taken matters for hash + which ones.
  for (let i = 0; i < state.world.coins.length; i++) {
    mix(state.world.coins[i].taken ? 1 : 0);
  }
  for (const dc of state.droppedCoins) { mix(dc.tx); mix(dc.ty); mix(dc.amount); }
  for (const pr of state.projectiles) { mix(pr.x); mix(pr.y); mix(pr.dir); mix(pr.ownerIdx); }
  for (const tr of state.traps) { mix(tr.tx); mix(tr.ty); mix(tr.ownerIdx); mix(tr.expiresAtTick); }
  return h >>> 0;
}