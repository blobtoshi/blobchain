// @ts-nocheck
// Shared constants for the BLOB chain UI.
export const BLOCK_TIME = 120;
export const INITIAL_REWARD = 10;
export const HALVING_BLOCKS = 1_000_000;
export const MAX_SUPPLY = 20_000_000;
export const MAX_BLOCK_SIZE = 1_000_000;
export const MAX_TX_SIZE = 100_000;
export const TX_FEE = 0.001;
export const BLOB_DECIMALS = 8;
export const BLOB_UNIT = 1e8;
export const BASE_FEE_RATE = 10;
export const MIN_FEE_RATE = 1;
export const MAX_MEMO_BYTES = 80;

export const GENESIS_TIME_MS = 1776731760000;

// Canvas dimensions / physics for Blob Run.
export const CW = 780;
export const CH = 360;
export const GY = 290;
export const PX = 130;
export const GRAVITY = 0.66;
export const JUMP_V = -14.5;

export const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
export const USER_RE = /^[A-Za-z0-9_]{3,24}$/;
export const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
export const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const PAGE_SIZE = 100;

// Reverse bridge (WBLOB → BLOB) — fee deducted from the redeemed amount.
// Sized to comfortably cover the server-signed credit tx network fee at peak congestion.
export const BRIDGE_FEE_BLOB = 0.0015;
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const BRIDGE_ADDRESS = "19xGuoUEng3w4Y2DjP6te2LLTSKt7fKs27";

export const GENESIS = {
  height: 0,
  previousHash: "0".repeat(64),
  timestamp: GENESIS_TIME_MS,
  transactions: [],
  miningEntries: [],
  winner: null,
  winnerScore: 0,
  winnerUsername: "Satoshi Blobamoto",
  reward: 0,
  seed: "genesis",
  hash: "genesis00000000000000000000000000000000000000000000000000000000blob",
  totalSupply: 0,
  nodeCount: 0,
};
