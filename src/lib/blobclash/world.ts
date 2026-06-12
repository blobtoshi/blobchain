// BlobClash — deterministic world generation (Phase 0).
//
// Map, coin placement, and base placement are all derived from a single
// integer seed (in production, derived from the previous block hash). Uses
// Mulberry32 — the same integer PRNG family the chain already uses in
// consensus — so node and client generate byte-identical worlds.

import { MAP_TILES, TILE_FLOOR, TILE_WALL, TILE_BASE, COIN_COUNT, MAX_PLAYERS, FP_ONE } from "./constants";

// Mulberry32: deterministic 32-bit PRNG. Returns a function yielding floats
// in [0,1). We only use it to derive integers via modulo, never to feed the
// sim directly (the sim is pure integer). Seeding/derivation is identical
// across all peers.
export function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Derive a sub-seed deterministically from a root seed + a string tag.
// Simple integer hash (FNV-1a-ish) so we don't need sha256 in the hot path.
export function subSeed(root: number, tag: string): number {
  let h = (root ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type ClashWorld = {
  seed: number;
  tiles: Uint8Array;           // MAP_TILES*MAP_TILES, row-major
  coins: { x: number; y: number; taken: boolean }[];   // tile coords
  bases: { x: number; y: number }[];                   // base-cluster centers, one per player slot
};

function idx(x: number, y: number): number { return y * MAP_TILES + x; }

// Generate the map. Border walls + scattered interior wall blocks (simple,
// deterministic, leaves plenty of open floor for a top-down arena). Then base
// clusters at spread-out positions, then coins on random floor tiles.
export function generateWorld(seed: number): ClashWorld {
  const tiles = new Uint8Array(MAP_TILES * MAP_TILES); // 0 = floor everywhere

  // 1. Solid border wall.
  for (let i = 0; i < MAP_TILES; i++) {
    tiles[idx(i, 0)] = TILE_WALL;
    tiles[idx(i, MAP_TILES - 1)] = TILE_WALL;
    tiles[idx(0, i)] = TILE_WALL;
    tiles[idx(MAP_TILES - 1, i)] = TILE_WALL;
  }

  // 2. Scattered interior wall blocks. Deterministic count + positions.
  // Count scales with map area so density stays consistent if MAP_TILES
  // changes (64^2 / 256 = 16 blocks).
  const wallRng = mulberry32(subSeed(seed, "walls"));
  const blockCount = Math.max(8, Math.floor((MAP_TILES * MAP_TILES) / 256));
  for (let b = 0; b < blockCount; b++) {
    const bw = 2 + Math.floor(wallRng() * 4);   // 2..5 wide
    const bh = 2 + Math.floor(wallRng() * 4);   // 2..5 tall
    const bx = 4 + Math.floor(wallRng() * (MAP_TILES - 8 - bw));
    const by = 4 + Math.floor(wallRng() * (MAP_TILES - 8 - bh));
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        tiles[idx(x, y)] = TILE_WALL;
      }
    }
  }

  // 3. Base clusters — one per player slot on a deterministic ring.
  //
  // DETERMINISM NOTE: we deliberately avoid Math.cos/Math.sin here. The
  // basic IEEE-754 ops (+ - * /, floor, round) are bit-exact across JS
  // engines, but TRANSCENDENTALS ARE NOT - Math.cos can differ in the last
  // bit between V8 / JSC / SpiderMonkey, which would generate different
  // worlds on different browsers and desync lockstep in Phase 1. Instead we
  // use a precomputed integer unit-circle table (cos/sin x 4096, rounded)
  // for the MAX_PLAYERS ring positions.
  const RING_DIR_4096: ReadonlyArray<readonly [number, number]> = [
    [ 4096,     0], [ 3314,  2408], [ 1266,  3896], [-1266,  3896], [-3314,  2408],
    [-4096,     0], [-3314, -2408], [-1266, -3896], [ 1266, -3896], [ 3314, -2408],
  ];
  const bases: { x: number; y: number }[] = [];
  const cx = MAP_TILES / 2;
  const cy = MAP_TILES / 2;
  const ring = MAP_TILES / 2 - 12;
  for (let p = 0; p < MAX_PLAYERS; p++) {
    const [c, s] = RING_DIR_4096[p];
    const bx = cx + Math.round((ring * c) / 4096);
    const by = cy + Math.round((ring * s) / 4096);
    // Clear a 5x5 floor pocket so the base has breathing room, and mark the
    // inner 3x3 as base tiles (the bankable/raidable footprint).
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = bx + dx, y = by + dy;
        if (x > 0 && x < MAP_TILES - 1 && y > 0 && y < MAP_TILES - 1) {
          const inBase = Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
          tiles[idx(x, y)] = inBase ? TILE_BASE : TILE_FLOOR;
        }
      }
    }
    bases.push({ x: bx, y: by });
  }

  // 4. Coins on random floor tiles (not walls, not base tiles). Fixed count.
  const coinRng = mulberry32(subSeed(seed, "coins"));
  const coins: { x: number; y: number; taken: boolean }[] = [];
  let guard = 0;
  while (coins.length < COIN_COUNT && guard < COIN_COUNT * 50) {
    guard++;
    const x = 1 + Math.floor(coinRng() * (MAP_TILES - 2));
    const y = 1 + Math.floor(coinRng() * (MAP_TILES - 2));
    if (tiles[idx(x, y)] !== TILE_FLOOR) continue;
    // Avoid duplicate coin on same tile.
    if (coins.some(c => c.x === x && c.y === y)) continue;
    coins.push({ x, y, taken: false });
  }

  return { seed, tiles, coins, bases };
}

export function tileAt(world: ClashWorld, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= MAP_TILES || y >= MAP_TILES) return TILE_WALL;
  return world.tiles[idx(x, y)];
}
