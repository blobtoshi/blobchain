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

export const GENESIS_TIME_MS = 1777517348838;

// Canvas dimensions / physics for Blob Run.
export const CW = 780;
export const CH = 360;
export const GY = 290;
export const PX = 130;
export const GRAVITY = 0.66;
export const JUMP_V = -14.5;

export const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
export const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const PAGE_SIZE = 100;

// Fee-rate buckets (drops/byte) for mempool histogram & "goggles" coloring.
// Each entry is the inclusive upper bound for the bucket; the last bucket is "+".
export const FEE_BUCKETS = [1, 5, 10, 20, 50, 100];

// Reverse bridge (WBLOB → BLOB) — fee deducted from the redeemed amount.
// Sized to comfortably cover the server-signed credit tx network fee at peak congestion.
export const BRIDGE_FEE_BLOB = 0.0015;
export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

// Bridge keypair address — pinned as a protocol constant, not part of the
// genesis block itself. The matching private key lives only in the
// BRIDGE_BLOB_PRIVATE_KEY secret on the bridge edge functions, which
// self-check that their loaded private key derives this exact address on
// every redeem call.
export const BRIDGE_ADDRESS = "1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs";

export const GENESIS = {
  height: 0,
  previousHash: "0".repeat(64),
  timestamp: GENESIS_TIME_MS,
  transactions: [],
  miningEntries: [],
  winner: null,
  winnerScore: 0,
  reward: 0,
  seed: "genesis",
  hash: "412c22f77b50de1a3faec282597d49b58a04bb5161e6d414f9885ab09de24bc7",
  totalSupply: 0,
  nodeCount: 0,
};

// Custom event used to navigate the explorer to a specific address from
// anywhere in the app. Listened to by Index (to switch screens) and by
// BlockExplorer (to open the address drawer).
export const ADDRESS_SELECT_EVENT = "blob:select-address";
export function emitSelectAddress(address: string) {
  if (!address || address === "coinbase") return;
  window.dispatchEvent(new CustomEvent(ADDRESS_SELECT_EVENT, { detail: address }));
}
