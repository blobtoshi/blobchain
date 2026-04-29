// Shared WebSocket protocol types for BLOB CHAIN.
// This file is intentionally framework-free so it can be imported by both the
// Node.js full node and the browser light client without bundling Node deps.

export type Tx = {
  id: string;
  from: string;
  to: string;
  amount: number;
  fee: number;
  feeRate: number;
  memo: string;
  signature: string;
  publicKey: string;
  timestamp: number;
};

export type Entry = {
  address: string;
  score: number;
  block_height: number;
  block_seed: string;
  signature: string;
  inputs?: string | null;
  inputs_hash?: string | null;
  frame_count?: number | null;
  engine_version?: number;
};

export type Block = {
  height: number;
  previousHash: string;
  timestamp: number;
  transactions: Tx[];
  miningEntries: Array<{ address: string; score: number; signature: string }>;
  winner: string | null;
  winnerScore: number;
  reward: number;
  seed: string;
  hash: string;
  totalSupply: number;
  nodeCount: number;
};

// ── Client → Server ────────────────────────────────────────────────────────
export type ClientMsg =
  | { type: "subscribe" }
  | { type: "ping"; t: number }
  | { type: "submitTx"; tx: SubmitTxPayload }
  | { type: "submitEntryCommit"; commit: SubmitEntryCommitPayload }
  | { type: "submitEntryReveal"; reveal: SubmitEntryRevealPayload }
  | { type: "getChainTip" }
  | { type: "getBlocks"; fromHeight: number; limit?: number }
  | { type: "getMempool" };

export type SubmitTxPayload = {
  id: string;
  from: string;
  to: string;
  amount: number;
  feeRate: number;
  memo?: string;
  signature: string;
  publicKey: string;
  timestamp: number;
};

/**
 * Phase 4: commit-reveal split.
 *
 * 1. Player finishes a run, computes inputs_hash, picks a random salt, and
 *    sends `submitEntryCommit` with `commit_hash = sha256(score|inputs_hash|salt)`
 *    plus a PoW nonce that satisfies ENTRY_POW_BITS.
 * 2. During the last ENTRY_REVEAL_WINDOW_SECONDS of the block window, the
 *    player sends `submitEntryReveal` with the actual score, inputs trace,
 *    salt, and a fresh signature. The node verifies that
 *    sha256(score|inputs_hash|salt) matches the stored commit_hash and that
 *    the deterministic replay produces the claimed score.
 *
 * Sealing only counts entries whose commit was received before the reveal
 * window opened — this kills "snipe-then-copy" attacks because by the time
 * an attacker sees a victim's inputs trace, no new commits are accepted.
 */
export type SubmitEntryCommitPayload = {
  address: string;
  block_height: number;
  commit_hash: string;       // sha256(score || inputs_hash || salt) — 64 hex
  pow_nonce: string;         // bound to (block_height, address, commit_hash)
  publicKey: string;
  signature: string;         // signs `commit:${block_height}:${address}:${commit_hash}`
  engine_version: number;
};

export type SubmitEntryRevealPayload = {
  address: string;
  block_height: number;
  block_seed: string;        // runtime seed for the height (must match prev hash)
  score: number;
  frame_count: number;
  inputs: string;            // canonical "f:t,f:t,..." trace
  inputs_hash: string;       // sha256(inputs) — must match the inputs_hash in the commit
  salt: string;              // 32 hex chars (16 bytes)
  publicKey: string;
  signature: string;         // signs `reveal:${block_height}:${address}:${score}:${inputs_hash}:${salt}`
  engine_version: number;
};

// ── Server → Client ────────────────────────────────────────────────────────
export type ServerMsg =
  | { type: "hello"; nodeId: string; version: string; chainTip: ChainTip }
  | { type: "pong"; t: number }
  | { type: "newBlock"; block: Block }
  | { type: "newTx"; tx: Tx }
  | { type: "newEntry"; entry: Entry }
  | { type: "chainTip"; tip: ChainTip }
  | { type: "blocksRange"; blocks: Block[] }
  | { type: "mempool"; txs: Tx[] }
  | { type: "ack"; ref: string; data?: unknown }
  | { type: "error"; ref?: string; message: string };

export type ChainTip = {
  height: number;
  hash: string;
  totalSupply: number;
  timestamp: number;
};

export const PROTOCOL_VERSION = "1.1.0";
