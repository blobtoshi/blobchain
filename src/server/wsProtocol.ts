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
  | { type: "submitEntry"; entry: SubmitEntryPayload }
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

export type SubmitEntryPayload = {
  address: string;
  score: number;
  block_height: number;
  block_seed: string;
  signature: string;
  publicKey: string;
  inputs: string;
  inputs_hash: string;
  frame_count: number;
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

export const PROTOCOL_VERSION = "1.0.0";
