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
<<<<<<< HEAD
  nonce?: string;
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

  signature: string;

  publicKey: string;

  timestamp: number;

};



export type Entry = {

<<<<<<< HEAD
  address: string;

  score: number;

  block_height: number;

  block_seed: string;

  signature: string;

  inputs?: string | null;

  inputs_hash?: string | null;

  frame_count?: number | null;

  engine_version?: number;

  pending?: boolean;

  // Phase 6: required for peer-side re-validation. Present when this is

  // a freshly-gossiped entry, absent when it's a UI-facing snapshot.

  pow_nonce?: string;

  publicKey?: string;

};



// C2: full mining-entry payload packed into a block. Carries everything a
// peer needs to re-run validateBlockEntry (signature + PoW + simulator replay)
// so a forged high-score entry can't smuggle a winner/reward through ingest.
export type BlockEntry = {
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
  address: string;

  score: number;

  block_height: number;

  block_seed: string;
<<<<<<< HEAD
  inputs: string;
  inputs_hash: string;
  frame_count: number;
  pow_nonce: string;
  publicKey: string;
  signature: string;
  engine_version: number;
=======

  signature: string;

  inputs?: string | null;

  inputs_hash?: string | null;

  frame_count?: number | null;

  engine_version?: number;

  pending?: boolean;

  // Phase 6: required for peer-side re-validation. Present when this is

  // a freshly-gossiped entry, absent when it's a UI-facing snapshot.

  pow_nonce?: string;

  publicKey?: string;

>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
};



export type Block = {

  height: number;

  previousHash: string;

  timestamp: number;

  transactions: Tx[];

<<<<<<< HEAD
  // C2: blocks now carry the FULL mining-entry payload so every node can
  // independently re-validate signature + PoW + simulator replay and recompute
  // the winner, instead of trusting the proposer's address/score/signature.
  miningEntries: BlockEntry[];
=======
  miningEntries: Array<{ address: string; score: number; signature: string }>;
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

  winner: string | null;

  winnerScore: number;

  reward: number;

  seed: string;

  hash: string;

  totalSupply: number;

  nodeCount: number;

};



<<<<<<< HEAD
// H1: signed peer-handshake token. Structurally identical to peerAuth.ts's
// PeerAuth (duplicated here so this framework-free file pulls in no node deps).
export type PeerAuth = { nodeId: string; ts: number; nonce: string; sig: string };

=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
// -- Client -> Server --------------------------------------------------------

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

  // Auto-mesh: a node sends this immediately after dialing another node so

  // the receiver can add a return connection. Browsers never send this, so

  // they remain regular subscribers.

<<<<<<< HEAD
  | { type: "peerIdentify"; peerUrl: string; nodeId: string; auth?: PeerAuth }
=======
  | { type: "peerIdentify"; peerUrl: string; nodeId: string }
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

  | { type: "getActiveEntries"; height: number }

  | { type: "activeStateHash"; height: number; hash: string };



export type SubmitTxPayload = {

  id: string;

  from: string;

  to: string;

  amount: number;

  feeRate: number;

  memo?: string;
<<<<<<< HEAD
  nonce?: string;
=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

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

 * window opened - this kills "snipe-then-copy" attacks because by the time

 * an attacker sees a victim's inputs trace, no new commits are accepted.

 */

export type SubmitEntryCommitPayload = {

  address: string;

  block_height: number;

  commit_hash: string;       // sha256(score || inputs_hash || salt) - 64 hex

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

  inputs_hash: string;       // sha256(inputs) - must match the inputs_hash in the commit

  salt: string;              // 32 hex chars (16 bytes)

  publicKey: string;

  signature: string;         // signs `reveal:${block_height}:${address}:${score}:${inputs_hash}:${salt}`

  engine_version: number;

};



/**

 * Phase 6: single-shot entry submission.

 *

 * The legacy commit-reveal split was redundant: snipe protection comes from

 * the commit-window cutoff (no submissions in the last ENTRY_REVEAL_WINDOW_SECONDS),

 * not from blinding the score. By the time an attacker sees a high score on

 * the gossip stream, the cutoff has already passed and they can't react.

 *

 * Removing the split eliminates the abandoned-commit failure mode: a player

 * submits once, and even if their browser closes immediately after, the

 * entry is fully recorded on every node. No reveal step needed.

 */

export type SubmitEntryPayload = {

  address: string;

  block_height: number;

  block_seed: string;        // runtime seed for the height (must match prev hash)

  score: number;

  frame_count: number;

  inputs: string;            // canonical "f:t,f:t,..." trace

  inputs_hash: string;       // sha256(inputs)

  pow_nonce: string;         // PoW over (block_height, address, inputs_hash)

  publicKey: string;

  signature: string;         // signs `entry:${block_height}:${address}:${score}:${inputs_hash}`

  engine_version: number;

};



// Phase 5: a commit announced over gossip (no inputs yet, just the binding).

// All fields needed for any node to validate and re-store the commit.

export type EntryCommit = {

  address: string;

  block_height: number;

  commit_hash: string;

  pow_nonce: string;

  publicKey: string;

  signature: string;

  engine_version: number;

  received_at: number;        // ms; for ordering when multiple commits race

};



// -- Server -> Client --------------------------------------------------------

export type ServerMsg =

<<<<<<< HEAD
  | { type: "hello"; nodeId: string; version: string; chainTip: ChainTip; auth?: PeerAuth }
=======
  | { type: "hello"; nodeId: string; version: string; chainTip: ChainTip }
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

  | { type: "pong"; t: number }

  | { type: "newBlock"; block: Block }

  | { type: "newTx"; tx: Tx }

  | { type: "newEntry"; entry: Entry }

  | { type: "newEntryCommit"; commit: EntryCommit }

  | { type: "activeEntries"; height: number; commits: EntryCommit[]; reveals: Entry[] }

<<<<<<< HEAD
  | { type: "getActiveEntries"; height: number }

=======
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154
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
