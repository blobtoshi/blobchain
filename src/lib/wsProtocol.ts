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
  nonce?: string;
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
  // True when this row represents a commit only (no reveal yet). UI surfaces
  // these as "Committed" with no score until reveal.
  pending?: boolean;
  // Phase 6: required for peer-side re-validation. Present when this is
  // a freshly-gossiped entry, absent when it's a UI-facing snapshot.
  pow_nonce?: string;
  publicKey?: string;
};

// Phase 5: a commit announced over gossip (no inputs yet, just the binding).
export type EntryCommit = {
  address: string;
  block_height: number;
  commit_hash: string;
  pow_nonce: string;
  publicKey: string;
  signature: string;
  engine_version: number;
  received_at: number;
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
  | { type: "submitEntry"; entry: SubmitEntryPayload }
  | { type: "submitEntryCommit"; commit: SubmitEntryCommitPayload }
  | { type: "submitEntryReveal"; reveal: SubmitEntryRevealPayload }
  | { type: "getChainTip" }
  | { type: "getBlocks"; fromHeight: number; limit?: number }
  | { type: "getMempool" }
  | { type: "getActiveEntries"; height: number }
  | { type: "activeStateHash"; height: number; hash: string }
  // Auto-mesh: nodes send this when dialing peers. Browsers never send it.
  | { type: "peerIdentify"; peerUrl: string; nodeId: string };

export type SubmitTxPayload = {
  id: string;
  from: string;
  to: string;
  amount: number;
  feeRate: number;
  memo?: string;
  nonce?: string;
  signature: string;
  publicKey: string;
  timestamp: number;
};

// Phase 6: single-shot entry submission. The score, inputs, and PoW are
// all sent in one message - no separate reveal step. Snipe protection
// comes from the commit-window cutoff (no submissions accepted in the
// last ENTRY_REVEAL_WINDOW_SECONDS), not from blinding the score.
export type SubmitEntryPayload = {
  address: string;
  block_height: number;
  block_seed: string;
  score: number;
  frame_count: number;
  inputs: string;
  inputs_hash: string;
  pow_nonce: string;         // PoW over (block_height, address, inputs_hash)
  publicKey: string;
  signature: string;         // signs `entry:${block_height}:${address}:${score}:${inputs_hash}`
  engine_version: number;
};

export type SubmitEntryCommitPayload = {
  address: string;
  block_height: number;
  commit_hash: string;
  pow_nonce: string;
  publicKey: string;
  signature: string;
  engine_version: number;
};

export type SubmitEntryRevealPayload = {
  address: string;
  block_height: number;
  block_seed: string;
  score: number;
  frame_count: number;
  inputs: string;
  inputs_hash: string;
  salt: string;
  publicKey: string;
  signature: string;
  engine_version: number;
};

// ── Server → Client ────────────────────────────────────────────────────────
export type ServerMsg =
  | { type: "hello"; nodeId: string; version: string; chainTip: ChainTip }
  | { type: "pong"; t: number }
  | { type: "newBlock"; block: Block }
  | { type: "newTx"; tx: Tx }
  | { type: "newEntry"; entry: Entry }
  | { type: "newEntryCommit"; commit: EntryCommit }
  | { type: "activeEntries"; height: number; commits: EntryCommit[]; reveals: Entry[] }
  | { type: "activeStateHash"; height: number; hash: string }
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

export const PROTOCOL_VERSION = "2.0.0";