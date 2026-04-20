// ═══════════════════════════════════════════════════════════════════════════════
// blobP2P.ts — Fully decentralized P2P relay for BLOB Chain
// WebRTC (PeerJS) + IndexedDB. Every browser tab = full validating node.
//
// Includes: chain/mempool/entries (drop-in compatible with old blobRelay)
//   + Order Book (BLOB ↔ USDC) with partial fills, maker min-fill,
//     fixed 10-block escrow timeout, and signature + USDC tx-hash proofs.
//
// SIGNALING SERVER:
//   Currently using public 0.peerjs.com (flaky — fine for testnet).
//   Replace CONFIG.SIGNALING_HOST with your own once deployed.
// ═══════════════════════════════════════════════════════════════════════════════

import Peer, { type DataConnection } from "peerjs";
import { openDB, type IDBPDatabase } from "idb";

// ── TYPES ────────────────────────────────────────────────────────────────────
export type Block = {
  height: number;
  previousHash: string;
  timestamp: number;
  transactions: any[];
  miningEntries: any[];
  winner: string | null;
  winnerUsername?: string | null;
  winnerScore?: number;
  reward: number;
  seed: string;
  hash: string;
  totalSupply?: number;
  nodeCount?: number;
};

export type Tx = {
  id: string;
  from: string;
  fromUsername?: string;
  to: string;
  amount: number;
  fee?: number;
  signature: string;
  publicKey: string;
  timestamp: number;
};

export type Entry = {
  address: string;
  username?: string;
  score: number;
  block_height: number;
  block_seed?: string;
  signature: string;
};

export type Order = {
  id: string;
  type: "buy" | "sell";          // "sell" = sell BLOB for USDC, "buy" = buy BLOB with USDC
  blobAmount: number;            // total BLOB in this order
  usdcAmount: number;            // total USDC in this order (price = usdc / blob)
  remainingBlob: number;         // remaining unfilled BLOB
  minFill: number;               // minimum BLOB per fill (maker-set, dust prevention)
  usdcChain: "base" | "solana" | "ethereum" | "arbitrum";
  usdcAddress: string;           // maker's receive (sell) or send (buy) USDC address
  makerAddress: string;
  makerUsername?: string;
  makerPublicKey: string;
  signature: string;             // sig over canonical order payload
  timestamp: number;
  status: "open" | "partial" | "filled" | "cancelled";
};

export type Escrow = {
  id: string;
  orderId: string;
  takerAddress: string;
  takerUsername?: string;
  takerPublicKey: string;
  makerAddress: string;
  blobAmount: number;            // BLOB locked for this fill
  usdcAmount: number;            // USDC owed for this fill
  usdcChain: Order["usdcChain"];
  usdcTxHash?: string;           // set on release
  releaseSignature?: string;     // taker sig over (escrowId + usdcTxHash)
  status: "locked" | "released" | "refunded";
  createdHeight: number;
  timeoutHeight: number;         // createdHeight + ESCROW_TIMEOUT_BLOCKS
  signature: string;             // taker sig over canonical escrow payload
};

export type RelayHandlers = {
  onBlock?: (b: Block) => void;
  onTx?: (t: Tx) => void;
  onTxRemoved?: (id: string) => void;
  onEntry?: (e: Entry) => void;
  onOrder?: (o: Order) => void;
  onEscrow?: (e: Escrow) => void;
  onPeers?: (count: number) => void;
};

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  SIGNALING_HOST: "0.peerjs.com",   // TEMP — swap for your Railway URL
  SIGNALING_PORT: 443,
  SIGNALING_PATH: "/",
  SIGNALING_KEY: "peerjs",
  BOOTSTRAP_PEERS: [] as string[],
};

const ESCROW_TIMEOUT_BLOCKS = 10;

// ── STATE ────────────────────────────────────────────────────────────────────
let peer: Peer | null = null;
let myPeerId = "";
let myAddress = "";
const connections = new Map<string, DataConnection>();
const handlers: RelayHandlers = {};

let localChain: Block[] = [];
let localMempool: Tx[] = [];
const localEntries = new Map<number, Entry[]>();
let localOrders: Order[] = [];
let localEscrows: Escrow[] = [];

// ── INDEXEDDB ────────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB("blob-chain-db", 2, {
      upgrade(db, oldVersion) {
        if (!db.objectStoreNames.contains("chain"))
          db.createObjectStore("chain", { keyPath: "height" });
        if (!db.objectStoreNames.contains("mempool"))
          db.createObjectStore("mempool", { keyPath: "id" });
        if (!db.objectStoreNames.contains("entries")) {
          const s = db.createObjectStore("entries", { keyPath: ["block_height", "address"] });
          s.createIndex("block_height", "block_height");
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains("orders"))
            db.createObjectStore("orders", { keyPath: "id" });
          if (!db.objectStoreNames.contains("escrows"))
            db.createObjectStore("escrows", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

async function loadLocalData() {
  const db = await getDB();
  localChain = (await db.getAll("chain")).sort((a, b) => a.height - b.height);
  localMempool = await db.getAll("mempool");
  localEntries.clear();
  for (const e of (await db.getAll("entries")) as Entry[]) {
    if (!localEntries.has(e.block_height)) localEntries.set(e.block_height, []);
    localEntries.get(e.block_height)!.push(e);
  }
  localOrders = await db.getAll("orders");
  localEscrows = await db.getAll("escrows");
}

const saveChainBlock = async (b: Block) => (await getDB()).put("chain", b);
const saveMempoolTx = async (t: Tx) => (await getDB()).put("mempool", t);
const removeMempoolIds = async (ids: string[]) => {
  const db = await getDB();
  await Promise.all(ids.map((id) => db.delete("mempool", id)));
};
const saveEntryRow = async (e: Entry) => (await getDB()).put("entries", e);
const saveOrderRow = async (o: Order) => (await getDB()).put("orders", o);
const saveEscrowRow = async (e: Escrow) => (await getDB()).put("escrows", e);

// ── P2P INIT ─────────────────────────────────────────────────────────────────
export async function initP2P(walletAddress: string) {
  await loadLocalData();
  myAddress = walletAddress;
  myPeerId = `blob-${walletAddress.slice(2, 18)}`;

  peer = new Peer(myPeerId, {
    host: CONFIG.SIGNALING_HOST,
    port: CONFIG.SIGNALING_PORT,
    path: CONFIG.SIGNALING_PATH,
    secure: true,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    },
  });

  peer.on("open", (id) => {
    console.log(`🟢 BLOB P2P node ready — peer id: ${id}`);
    CONFIG.BOOTSTRAP_PEERS.forEach(connectToPeer);
  });
  peer.on("connection", handleNewConnection);
  peer.on("error", (err) => console.warn("[p2p] peer error:", err.type, err.message));
}

export function getMyPeerId() {
  return myPeerId;
}

export function getPeerCount() {
  return connections.size;
}

export function connectToPeer(remotePeerId: string) {
  if (!peer || !remotePeerId || remotePeerId === myPeerId) return;
  if (connections.has(remotePeerId)) return;
  try {
    const conn = peer.connect(remotePeerId, { reliable: true });
    handleNewConnection(conn);
  } catch (e) {
    console.warn("[p2p] connect failed", e);
  }
}

// ── CONNECTION + GOSSIP ──────────────────────────────────────────────────────
function handleNewConnection(conn: DataConnection) {
  connections.set(conn.peer, conn);
  handlers.onPeers?.(connections.size);

  conn.on("open", () => {
    const latestHeight = localChain.length ? localChain[localChain.length - 1].height : -1;
    safeSend(conn, { type: "CHAIN_SUMMARY", height: latestHeight });
    // share open orders + active escrows with new peer
    localOrders.filter((o) => o.status === "open" || o.status === "partial")
      .forEach((o) => safeSend(conn, { type: "NEW_ORDER", order: o }));
    localEscrows.filter((e) => e.status === "locked")
      .forEach((e) => safeSend(conn, { type: "NEW_ESCROW", escrow: e }));
  });

  conn.on("data", async (data: any) => {
    if (!data || !data.type) return;
    try {
      switch (data.type) {
        case "NEW_BLOCK": await handleIncomingBlock(data.block); break;
        case "NEW_TX": await handleIncomingTx(data.tx); break;
        case "TX_REMOVED": await handleIncomingTxRemoved(data.ids ?? [data.id]); break;
        case "NEW_ENTRY": await handleIncomingEntry(data.entry); break;
        case "NEW_ORDER": await handleIncomingOrder(data.order); break;
        case "NEW_ESCROW": await handleIncomingEscrow(data.escrow); break;
        case "CHAIN_SUMMARY": await handleChainSummary(conn, data.height); break;
        case "CHAIN_SYNC_REQUEST": await sendMissingBlocks(conn, data.fromHeight); break;
        case "CHAIN_SYNC_RESPONSE": await handleChainSyncResponse(data.blocks); break;
      }
    } catch (e) {
      console.warn("[p2p] handler error", data.type, e);
    }
  });

  const cleanup = () => {
    connections.delete(conn.peer);
    handlers.onPeers?.(connections.size);
  };
  conn.on("close", cleanup);
  conn.on("error", cleanup);
}

function safeSend(conn: DataConnection, msg: any) {
  try { if (conn.open) conn.send(msg); } catch { /* noop */ }
}

function broadcast(msg: any) {
  connections.forEach((c) => safeSend(c, msg));
}

// ── INCOMING HANDLERS ────────────────────────────────────────────────────────
async function handleIncomingBlock(block: Block) {
  if (localChain.find((b) => b.height === block.height)) return;
  // FIXED: expected height = current chain length (genesis is index 0)
  const expected = localChain.length;
  if (block.height !== expected) {
    if (block.height > expected) {
      console.warn(`[p2p] gap/future block (expected ${expected}, got ${block.height}) — syncing`);
      requestChainSync();
    }
    return;
  }
  localChain.push(block);
  await saveChainBlock(block);
  // Auto-refund expired escrows when chain progresses
  await processEscrowTimeouts(block.height);
  handlers.onBlock?.(block);
  broadcast({ type: "NEW_BLOCK", block });
}

async function handleIncomingTx(tx: Tx) {
  if (localMempool.find((t) => t.id === tx.id)) return;
  localMempool.push(tx);
  await saveMempoolTx(tx);
  handlers.onTx?.(tx);
  broadcast({ type: "NEW_TX", tx });
}

async function handleIncomingTxRemoved(ids: string[]) {
  if (!ids?.length) return;
  const toRemove = ids.filter((id) => localMempool.find((t) => t.id === id));
  if (!toRemove.length) return;
  localMempool = localMempool.filter((t) => !toRemove.includes(t.id));
  await removeMempoolIds(toRemove);
  toRemove.forEach((id) => handlers.onTxRemoved?.(id));
  broadcast({ type: "TX_REMOVED", ids: toRemove });
}

async function handleIncomingEntry(entry: Entry) {
  let list = localEntries.get(entry.block_height) || [];
  const existing = list.find((e) => e.address === entry.address);
  if (existing && existing.score >= entry.score) return;
  list = list.filter((e) => e.address !== entry.address);
  list.push(entry);
  localEntries.set(entry.block_height, list);
  await saveEntryRow(entry);
  handlers.onEntry?.(entry);
  broadcast({ type: "NEW_ENTRY", entry });
}

async function handleIncomingOrder(order: Order) {
  const i = localOrders.findIndex((o) => o.id === order.id);
  if (i >= 0) {
    // newer status / smaller remaining wins
    const cur = localOrders[i];
    if (cur.status === "cancelled" || cur.status === "filled") return;
    if (order.remainingBlob >= cur.remainingBlob && cur.status === order.status) return;
    localOrders[i] = order;
  } else {
    localOrders.push(order);
  }
  await saveOrderRow(order);
  handlers.onOrder?.(order);
  broadcast({ type: "NEW_ORDER", order });
}

async function handleIncomingEscrow(escrow: Escrow) {
  const i = localEscrows.findIndex((e) => e.id === escrow.id);
  if (i >= 0) {
    const cur = localEscrows[i];
    // terminal states win; otherwise keep latest
    if (cur.status !== "locked" && escrow.status === "locked") return;
    localEscrows[i] = escrow;
  } else {
    localEscrows.push(escrow);
  }
  await saveEscrowRow(escrow);
  handlers.onEscrow?.(escrow);
  broadcast({ type: "NEW_ESCROW", escrow });
}

// ── CHAIN SYNC ───────────────────────────────────────────────────────────────
async function handleChainSummary(conn: DataConnection, remoteHeight: number) {
  const myHeight = localChain.length ? localChain[localChain.length - 1].height : -1;
  if (remoteHeight > myHeight) {
    safeSend(conn, { type: "CHAIN_SYNC_REQUEST", fromHeight: myHeight + 1 });
  } else if (remoteHeight < myHeight) {
    await sendMissingBlocks(conn, remoteHeight + 1);
  }
}

function requestChainSync() {
  const myHeight = localChain.length ? localChain[localChain.length - 1].height : -1;
  connections.forEach((c) => safeSend(c, { type: "CHAIN_SYNC_REQUEST", fromHeight: myHeight + 1 }));
}

async function sendMissingBlocks(conn: DataConnection, fromHeight: number) {
  const missing = localChain.filter((b) => b.height >= fromHeight);
  if (missing.length) safeSend(conn, { type: "CHAIN_SYNC_RESPONSE", blocks: missing });
}

async function handleChainSyncResponse(blocks: Block[]) {
  // process in order
  blocks.sort((a, b) => a.height - b.height);
  for (const b of blocks) await handleIncomingBlock(b);
}

// ── ESCROW TIMEOUT PROCESSING ────────────────────────────────────────────────
async function processEscrowTimeouts(currentHeight: number) {
  for (const e of localEscrows) {
    if (e.status === "locked" && currentHeight >= e.timeoutHeight) {
      e.status = "refunded";
      await saveEscrowRow(e);
      // restore order's remaining BLOB
      const order = localOrders.find((o) => o.id === e.orderId);
      if (order) {
        order.remainingBlob = Math.min(order.blobAmount, order.remainingBlob + e.blobAmount);
        order.status = order.remainingBlob >= order.blobAmount ? "open" : "partial";
        await saveOrderRow(order);
        handlers.onOrder?.(order);
      }
      handlers.onEscrow?.(e);
    }
  }
}

// ── PUBLIC API: chain / mempool / entries (drop-in compat) ───────────────────
export async function fetchChain(): Promise<Block[]> {
  return [...localChain];
}

export async function pushBlock(b: Block) {
  if (!localChain.find((x) => x.height === b.height)) {
    const expected = localChain.length;
    if (b.height === expected) {
      localChain.push(b);
      await saveChainBlock(b);
      await processEscrowTimeouts(b.height);
      handlers.onBlock?.(b);
    }
  }
  broadcast({ type: "NEW_BLOCK", block: b });
}

export async function fetchMempool(): Promise<Tx[]> {
  return [...localMempool];
}

export async function pushTx(tx: Tx) {
  if (!localMempool.find((t) => t.id === tx.id)) {
    localMempool.push(tx);
    await saveMempoolTx(tx);
    handlers.onTx?.(tx);
  }
  broadcast({ type: "NEW_TX", tx });
}

export async function clearTxs(ids: string[]) {
  if (!ids?.length) return;
  localMempool = localMempool.filter((t) => !ids.includes(t.id));
  await removeMempoolIds(ids);
  ids.forEach((id) => handlers.onTxRemoved?.(id));
  broadcast({ type: "TX_REMOVED", ids });
}

export async function fetchEntries(blockHeight: number): Promise<Entry[]> {
  return [...(localEntries.get(blockHeight) || [])];
}

export async function pushEntry(e: Entry) {
  let list = localEntries.get(e.block_height) || [];
  const existing = list.find((x) => x.address === e.address);
  if (existing && existing.score >= e.score) return;
  list = list.filter((x) => x.address !== e.address);
  list.push(e);
  localEntries.set(e.block_height, list);
  await saveEntryRow(e);
  handlers.onEntry?.(e);
  broadcast({ type: "NEW_ENTRY", entry: e });
}

// ── PUBLIC API: order book + escrow ──────────────────────────────────────────
export async function fetchOrders(): Promise<Order[]> {
  return localOrders.filter((o) => o.status === "open" || o.status === "partial");
}

export async function fetchEscrows(): Promise<Escrow[]> {
  return [...localEscrows];
}

export async function pushOrder(order: Order) {
  // initialize remaining if maker forgot
  if (order.remainingBlob == null) order.remainingBlob = order.blobAmount;
  await handleIncomingOrder(order);
}

export async function takeOrderPartial(
  orderId: string,
  blobAmount: number,
  taker: { address: string; username?: string; publicKey: string; signature: string },
): Promise<Escrow | null> {
  const order = localOrders.find((o) => o.id === orderId);
  if (!order || (order.status !== "open" && order.status !== "partial")) return null;
  if (blobAmount < order.minFill) return null;
  if (blobAmount > order.remainingBlob) return null;

  const usdcAmount = (blobAmount / order.blobAmount) * order.usdcAmount;
  const currentHeight = localChain.length ? localChain[localChain.length - 1].height : 0;

  const escrow: Escrow = {
    id: `esc-${orderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    orderId,
    takerAddress: taker.address,
    takerUsername: taker.username,
    takerPublicKey: taker.publicKey,
    makerAddress: order.makerAddress,
    blobAmount,
    usdcAmount,
    usdcChain: order.usdcChain,
    status: "locked",
    createdHeight: currentHeight,
    timeoutHeight: currentHeight + ESCROW_TIMEOUT_BLOCKS,
    signature: taker.signature,
  };

  order.remainingBlob -= blobAmount;
  order.status = order.remainingBlob <= 0 ? "filled" : "partial";

  await saveOrderRow(order);
  await saveEscrowRow(escrow);
  localEscrows.push(escrow);

  handlers.onOrder?.(order);
  handlers.onEscrow?.(escrow);
  broadcast({ type: "NEW_ORDER", order });
  broadcast({ type: "NEW_ESCROW", escrow });
  return escrow;
}

export async function releaseEscrow(
  escrowId: string,
  usdcTxHash: string,
  releaseSignature: string,
) {
  const e = localEscrows.find((x) => x.id === escrowId);
  if (!e || e.status !== "locked") return;
  e.usdcTxHash = usdcTxHash;
  e.releaseSignature = releaseSignature;
  e.status = "released";
  await saveEscrowRow(e);
  handlers.onEscrow?.(e);
  broadcast({ type: "NEW_ESCROW", escrow: e });
}

export async function cancelOrder(orderId: string) {
  const order = localOrders.find((o) => o.id === orderId);
  if (!order || order.status === "filled" || order.status === "cancelled") return;
  // can't cancel if there are locked escrows against it
  const hasLocked = localEscrows.some((e) => e.orderId === orderId && e.status === "locked");
  if (hasLocked) return;
  order.status = "cancelled";
  await saveOrderRow(order);
  handlers.onOrder?.(order);
  broadcast({ type: "NEW_ORDER", order });
}

// ── SUBSCRIPTION + TEARDOWN ──────────────────────────────────────────────────
export function subscribeRelay(h: RelayHandlers) {
  Object.assign(handlers, h);
  // emit current peer count immediately
  h.onPeers?.(connections.size);
  return () => {
    for (const k of Object.keys(h)) delete (handlers as any)[k];
  };
}

export function destroyP2P() {
  connections.forEach((c) => { try { c.close(); } catch { /* noop */ } });
  connections.clear();
  if (peer) { try { peer.destroy(); } catch { /* noop */ } peer = null; }
}
