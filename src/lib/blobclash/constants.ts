// BlobClash — deterministic constants (Phase 0).
//
// EVERY value here is consensus-bound: the node validator and all clients
// must agree byte-for-byte. Changing any of these is a breaking change that
// requires bumping CLASH_ENGINE_VERSION and coordinating a node+client deploy.
//
// All gameplay math is 16.16 fixed-point integers. NO FLOATS in the sim.
// A "tile" is 1<<16 = 65536 fixed-point units.

export const CLASH_ENGINE_VERSION = 1;

// ── Fixed-point ──────────────────────────────────────────────────────────
export const FP_SHIFT = 16;
export const FP_ONE = 1 << FP_SHIFT;           // 65536 = one tile
export const FP_HALF = FP_ONE >> 1;

// Multiply two 16.16 fixed-point numbers. Uses BigInt internally to avoid
// 32-bit overflow on the intermediate product, then back to Number. All
// inputs/outputs are safe-integer fixed-point values.
export function fpMul(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b)) >> BigInt(FP_SHIFT));
}
export function fpFromInt(n: number): number { return n * FP_ONE; }
export function fpToTile(fp: number): number { return Math.floor(fp / FP_ONE); }

// ── World / map ────────────────────────────────────────────────────────────
export const MAP_TILES = 64;                   // 64 x 64 grid (halved from 128)
export const TILE_FLOOR = 0;
export const TILE_WALL  = 1;
export const TILE_BASE  = 2;                    // base-cluster tile (owner tracked separately)

// ── Tick / time ──────────────────────────────────────────────────────────
export const TICKS_PER_SEC = 15;
export const GAMEPLAY_SECONDS = 100;           // 10s..110s of the 120s block window
export const GAMEPLAY_TICKS = GAMEPLAY_SECONDS * TICKS_PER_SEC;   // 1500
export const FILL_SECONDS = 10;
export const SETTLE_SECONDS = 10;

export const RESPAWN_DELAY_TICKS = 5 * TICKS_PER_SEC;     // 75
export const INVINCIBLE_TICKS    = 5 * TICKS_PER_SEC;     // 75

// ── Players ────────────────────────────────────────────────────────────────
export const MAX_PLAYERS = 10;
export const START_HEALTH = 100;
export const HIT_DAMAGE = 10;
export const KILL_SCORE = 100;
export const COIN_SCORE = 50;

// Movement: 5 tiles/sec at 15 tps = 0.3333 tile/tick (fast/arcadey feel).
// 0.3333 * 65536 = 21845.3 -> 21845 (locked). Diagonal uses the cardinal
// value scaled by ~0.7071 (1/sqrt2) to normalize diagonal speed:
// 21845 * 0.7071 = 15446.4 -> 15446 (locked).
export const MOVE_SPEED_FP = 21845;            // per-tick, cardinal
export const MOVE_SPEED_DIAG_FP = 15446;       // per-tick, diagonal (normalized)

// 8 facing directions, index 0..7 = N, NE, E, SE, S, SW, W, NW.
// dx/dy in tile-units (not fixed-point); multiply by speed at apply time.
export const DIR8: ReadonlyArray<{ dx: number; dy: number; diag: boolean }> = [
  { dx:  0, dy: -1, diag: false }, // 0 N
  { dx:  1, dy: -1, diag: true  }, // 1 NE
  { dx:  1, dy:  0, diag: false }, // 2 E
  { dx:  1, dy:  1, diag: true  }, // 3 SE
  { dx:  0, dy:  1, diag: false }, // 4 S
  { dx: -1, dy:  1, diag: true  }, // 5 SW
  { dx: -1, dy:  0, diag: false }, // 6 W
  { dx: -1, dy: -1, diag: true  }, // 7 NW
];

// ── Combat ───────────────────────────────────────────────────────────────
// Attack hits any enemy whose tile is within ATTACK_RANGE tiles AND lies in
// the attacker's facing hemisphere (dot product of (target-attacker) with the
// facing vector > 0). Range 1 tile = melee.
export const ATTACK_RANGE_TILES = 1;

// Attack rate limit. Requested 0.5s; at 15 ticks/sec that is 7.5 ticks which
// is not representable, so locked to 8 ticks = 0.533s (rounded up - slightly
// favors defenders). Consensus constant.
export const ATTACK_COOLDOWN_TICKS = 8;

// ── Coins ──────────────────────────────────────────────────────────────────
// Fixed finite supply, no respawn. 100 coins on a 64^2 map (both halved from
// the original 200 / 128^2 — note coin DENSITY doubled, so the gather phase
// is brisker and contested). Once depleted, raiding/killing is the only way
// to grow score.
export const COIN_COUNT = 100;

// ── Base raiding ───────────────────────────────────────────────────────────
// Bases are a square footprint of (2*BASE_RADIUS+1) tiles. Banking and
// stealing work anywhere on that footprint (not just the center), so the base
// feels like a real place rather than a single pixel. radius 1 = 3x3.
export const BASE_RADIUS = 1;
// Standing on an enemy base-tile and holding "steal" transfers up to
// STEAL_PER_TICK banked coins from the base owner to the raider's carried,
// capped by what the owner has banked. 3/tick at 15tps = 45 coins/sec — fast
// enough to be threatening, slow enough that the owner can defend.
export const STEAL_PER_TICK = 3;

// ── Slime ────────────────────────────────────────────────────────────────
export const SLIME_MAX_PER_GAME = 5;
export const SLIME_COOLDOWN_TICKS = 8 * TICKS_PER_SEC;   // 120
export const SLIME_SLOW_TICKS = 3 * TICKS_PER_SEC;       // 45
export const SLIME_SLOW_NUM = 1;                         // slow multiplier = 1/2
export const SLIME_SLOW_DEN = 2;
export const SLIME_TRAP_LIFETIME_TICKS = 15 * TICKS_PER_SEC;  // 225 (confirmed)

// Projectile: range 6 tiles, speed 8 tiles/sec = 0.5333 tile/tick.
// 0.5333 * 65536 = 34952.5 -> 34953 (locked).
export const SLIME_PROJ_RANGE_TILES = 6;
export const SLIME_PROJ_SPEED_FP = 34953;      // per-tick

// Slime input actions (resolved client-side from tap vs hold before commit).
export const SLIME_NONE  = 0;
export const SLIME_THROW = 1;
export const SLIME_DROP  = 2;

// ── Input bit layout ────────────────────────────────────────────────────────
// One input per player per tick, packed into a single integer for compact
// commit-reveal. Deterministic decode below.
//   bits 0-3 : moveDir (0..8, where 8 = none)
//   bit  4   : attack (0/1)
//   bit  5   : steal  (0/1)
//   bits 6-7 : slimeAction (0=none,1=throw,2=drop)
export const MOVE_NONE = 8;

export function packInput(moveDir: number, attack: boolean, steal: boolean, slime: number): number {
  return (moveDir & 0xf)
    | ((attack ? 1 : 0) << 4)
    | ((steal ? 1 : 0) << 5)
    | ((slime & 0x3) << 6);
}
export function unpackInput(v: number) {
  return {
    moveDir: v & 0xf,
    attack: ((v >> 4) & 1) === 1,
    steal:  ((v >> 5) & 1) === 1,
    slime:  (v >> 6) & 0x3,
  };
}
