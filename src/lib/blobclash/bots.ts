// BlobClash — deterministic bot AI (Phase 0).
//
// Bots let us watch the engine play with no networking. The AI is fully
// deterministic (derives all choices from game state + a per-bot seed), so a
// full bot game is replayable and is what the determinism self-check runs.
//
// Bot behavior is intentionally simple but produces all the interesting
// events (movement, pickup, banking, combat, raiding, slime) so we exercise
// every code path in the engine:
//   - If carrying >= a threshold, head to own base to bank.
//   - Else seek the nearest untaken coin.
//   - If an enemy is adjacent and in front, attack.
//   - Occasionally throw slime at a nearby enemy.
//   - If coins are depleted, head to the richest enemy base and raid.

import {
  MOVE_NONE, packInput, SLIME_NONE, SLIME_THROW,
  fpToTile, DIR8,
} from "./constants";
import type { ClashState, ClashPlayer } from "./engine";

function dirTowards(fromTx: number, fromTy: number, toTx: number, toTy: number): number {
  const dx = Math.sign(toTx - fromTx);
  const dy = Math.sign(toTy - fromTy);
  if (dx === 0 && dy === 0) return MOVE_NONE;
  // Map (dx,dy) in {-1,0,1} to a DIR8 index.
  for (let i = 0; i < 8; i++) {
    if (DIR8[i].dx === dx && DIR8[i].dy === dy) return i;
  }
  return MOVE_NONE;
}

function nearestCoin(state: ClashState, tx: number, ty: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const c of state.world.coins) {
    if (c.taken) continue;
    const d = Math.abs(c.x - tx) + Math.abs(c.y - ty);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function richestEnemyBase(state: ClashState, me: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestBank = -1;
  for (let j = 0; j < state.players.length; j++) {
    if (j === me) continue;
    const owner = state.players[j];
    if (owner.banked > bestBank) { bestBank = owner.banked; best = state.world.bases[j]; }
  }
  return bestBank > 0 ? best : null;
}

// Compute the packed input for one bot this tick.
export function botInput(state: ClashState, p: ClashPlayer): number {
  if (!p.alive) return packInput(MOVE_NONE, false, false, SLIME_NONE);
  const tx = fpToTile(p.x), ty = fpToTile(p.y);
  const base = state.world.bases[p.idx];

  // 1. Adjacent enemy in front -> attack.
  for (let j = 0; j < state.players.length; j++) {
    if (j === p.idx) continue;
    const e = state.players[j];
    if (!e.alive) continue;
    const dxt = fpToTile(e.x) - tx, dyt = fpToTile(e.y) - ty;
    if (Math.abs(dxt) <= 1 && Math.abs(dyt) <= 1) {
      const fd = DIR8[p.facing];
      const dot = fd.dx * dxt + fd.dy * dyt;
      if (dot > 0 || (dxt === 0 && dyt === 0)) {
        return packInput(p.facing, true, false, SLIME_NONE);
      }
      // Enemy adjacent but not in front: turn toward them (move) and slime if ready.
      const td = dirTowards(tx, ty, fpToTile(e.x), fpToTile(e.y));
      const slime = (p.slimesLeft > 0 && state.tick >= p.slimeReadyTick) ? SLIME_THROW : SLIME_NONE;
      return packInput(td, false, false, slime);
    }
  }

  // 2. Carrying enough -> bank it.
  if (p.carried >= 5) {
    if (tx === base.x && ty === base.y) {
      return packInput(MOVE_NONE, false, false, SLIME_NONE); // banking happens automatically
    }
    return packInput(dirTowards(tx, ty, base.x, base.y), false, false, SLIME_NONE);
  }

  // 3. Seek nearest coin.
  const coin = nearestCoin(state, tx, ty);
  if (coin) {
    return packInput(dirTowards(tx, ty, coin.x, coin.y), false, false, SLIME_NONE);
  }

  // 4. No coins left -> raid richest enemy base.
  const raid = richestEnemyBase(state, p.idx);
  if (raid) {
    if (tx === raid.x && ty === raid.y) {
      return packInput(MOVE_NONE, false, true, SLIME_NONE); // steal
    }
    return packInput(dirTowards(tx, ty, raid.x, raid.y), false, true, SLIME_NONE);
  }

  // 5. Nothing to do -> bank whatever we have.
  if (p.carried > 0) return packInput(dirTowards(tx, ty, base.x, base.y), false, false, SLIME_NONE);
  return packInput(MOVE_NONE, false, false, SLIME_NONE);
}

export function allBotInputs(state: ClashState): number[] {
  return state.players.map(p => botInput(state, p));
}
