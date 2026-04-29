// ── ENTRY (peer gossip — already validated by originating node) ─────────────
// Peer-gossiped entries have already passed commit-reveal on the sender.
// We skip commit verification and just upsert if it's a new best.
export type IngestEntryResult =
  | { ok: true; isNewBest: boolean; address: string; score: number; block_height: number; block_seed: string; signature: string }
  | { ok: false; error: string };

export function ingestEntry(d: DB, payload: {
  address: string; score: number;
  block_height: number; block_seed: string;
  signature: string; publicKey: string;
  inputs: unknown; inputs_hash: string;
  frame_count: number; engine_version: number;
}): IngestEntryResult {
  if (!payload.address || typeof payload.score !== "number") {
    return { ok: false, error: "invalid entry payload" };
  }
  const existing = d.stmts.getExistingEntry.get(payload.address, payload.block_height);
  if (existing && existing.score >= payload.score) {
    return {
      ok: true, isNewBest: false,
      address: payload.address, score: existing.score,
      block_height: payload.block_height,
      block_seed: payload.block_seed,
      signature: payload.signature,
    };
  }
  d.stmts.upsertEntry.run({
    address: payload.address,
    block_height: payload.block_height,
    score: payload.score,
    block_seed: payload.block_seed,
    signature: payload.signature,
    inputs: payload.inputs ? JSON.stringify(payload.inputs) : null,
    inputs_hash: payload.inputs_hash ?? null,
    frame_count: payload.frame_count ?? null,
  });
  return {
    ok: true, isNewBest: true,
    address: payload.address, score: payload.score,
    block_height: payload.block_height,
    block_seed: payload.block_seed,
    signature: payload.signature,
  };
}
