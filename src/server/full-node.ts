// BLOB CHAIN full node — single-process server providing:
//   • HTTP REST endpoints for debugging (`/health`, `/chain/tip`, `/blocks`, `/mempool`, `/fee-info`)
//   • WebSocket relay (subscribe + submit tx/entry, gossip new blocks)
//   • Deterministic 120s block sealer (re-implements the seal-block edge function)
//
// Designed to be byte-for-byte consensus-compatible with the existing
// Supabase-backed chain so a future migration can replay history and merge.

import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";

import { openDb, rowToBlock, rowToTx, rowToEntry, type DB } from "./lib/db.js";
import {
  validateTx, validateEntry, feeInfo,
} from "./lib/validate.js";
import {
  BLOCK_TIME_SECONDS, GENESIS_HASH, GENESIS_TIME_MS, MAX_BLOCK_SIZE, MAX_TX_SIZE,
  MAX_SUPPLY, computeBlockHash, getRewardForHeight, pickWinner,
  seedForHeight, to8, currentHeight,
} from "./lib/consensus.js";
import { Gossip, send } from "./lib/gossip.js";
import type {
  ChainTip, ClientMsg, ServerMsg, Block, Tx,
} from "./wsProtocol.js";
import { PROTOCOL_VERSION } from "./wsProtocol.js";

// ── Config ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? "./data/blobchain.db";
const NODE_ID = process.env.NODE_ID ?? randomUUID();

// ── Bootstrap ───────────────────────────────────────────────────────────
const d: DB = openDb(DB_PATH);
const gossip = new Gossip();

function chainTip(): ChainTip {
  const t = d.stmts.getTip.get();
  if (!t) {
    return { height: 0, hash: GENESIS_HASH, totalSupply: 0, timestamp: GENESIS_TIME_MS };
  }
  return {
    height: t.height,
    hash: t.hash,
    totalSupply: t.total_supply,
    timestamp: t.timestamp,
  };
}

function log(level: "info" | "warn" | "error", msg: string, extra?: unknown) {
  const line = { t: new Date().toISOString(), level, node: NODE_ID.slice(0, 8), msg, ...(extra ? { extra } : {}) };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

// ── HTTP API ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  next();
});

app.get("/health", (_req, res) => {
  const tip = chainTip();
  res.json({
    ok: true,
    nodeId: NODE_ID,
    version: PROTOCOL_VERSION,
    height: tip.height,
    tipHash: tip.hash,
    peers: gossip.count(),
    wallHeight: currentHeight(),
  });
});

app.get("/chain/tip", (req, res) => {
  const tip = chainTip();
  // ETag = height:hash so clients polling can short-circuit with If-None-Match.
  const etag = `"${tip.height}-${tip.hash.slice(0, 16)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  res.json(tip);
});

app.get("/blocks", (req, res) => {
  const fromRaw = Number(req.query.from);
  const from = Number.isFinite(fromRaw) ? Math.max(0, fromRaw | 0) : 1;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(500, Math.max(1, limitRaw | 0))
    : 100;
  const rows = d.stmts.getBlocksFrom.all(from, limit);
  res.setHeader("Cache-Control", "no-store");
  res.json(rows.map(rowToBlock));
});

app.get("/blocks/:height", (req, res) => {
  const h = Number(req.params.height);
  if (!Number.isFinite(h) || h < 0) {
    res.status(400).json({ error: "invalid height" });
    return;
  }
  const row = d.stmts.getBlockByHeight.get(h);
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.json(rowToBlock(row));
});

app.get("/mempool", (req, res) => {
  const sinceRaw = Number(req.query.since);
  const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
  const all = d.stmts.getMempool.all().map(rowToTx);
  const filtered = since > 0 ? all.filter((t) => t.timestamp > since) : all;
  res.setHeader("Cache-Control", "no-store");
  res.json(filtered);
});

app.get("/fee-info", (_req, res) => res.json(feeInfo(d)));

// ── WebSocket API ───────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  log("info", `full node listening on :${PORT}`, { dbPath: DB_PATH, nodeId: NODE_ID });
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

// Per-socket state: tracks malformed-message strikes for backpressure, and the
// last block height we've delivered so a reconnecting client can resync.
const MAX_MALFORMED = 5;
const sockState = new WeakMap<WebSocket, { strikes: number }>();

wss.on("connection", (ws) => {
  sockState.set(ws, { strikes: 0 });
  // Greet immediately with our identity + tip so the client can decide
  // whether to request a sync.
  send(ws, { type: "hello", nodeId: NODE_ID, version: PROTOCOL_VERSION, chainTip: chainTip() });

  ws.on("message", (raw) => {
    const state = sockState.get(ws) ?? { strikes: 0 };
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); }
    catch {
      state.strikes += 1;
      sockState.set(ws, state);
      send(ws, { type: "error", message: "invalid json" });
      if (state.strikes >= MAX_MALFORMED) {
        log("warn", "dropping socket: too many malformed messages");
        try { ws.close(1008, "malformed"); } catch { /* ignore */ }
      }
      return;
    }
    handleMessage(ws, msg).catch((e) => {
      log("error", "handler crashed", { err: String(e) });
      send(ws, { type: "error", message: "internal error" });
    });
  });

  ws.on("close", () => {
    gossip.unsubscribe(ws);
    sockState.delete(ws);
  });
});

async function handleMessage(ws: WebSocket, msg: ClientMsg) {
  switch (msg.type) {
    case "subscribe": {
      gossip.subscribe(ws);
      return send(ws, { type: "ack", ref: "subscribe" });
    }
    case "ping":
      return send(ws, { type: "pong", t: msg.t });

    case "getChainTip":
      return send(ws, { type: "chainTip", tip: chainTip() });

    case "getBlocks": {
      const from = Math.max(0, msg.fromHeight | 0);
      const limit = Math.min(500, Math.max(1, (msg.limit ?? 100) | 0));
      const blocks = d.stmts.getBlocksFrom.all(from, limit).map(rowToBlock);
      return send(ws, { type: "blocksRange", blocks });
    }

    case "getMempool":
      return send(ws, { type: "mempool", txs: d.stmts.getMempool.all().map(rowToTx) });

    case "submitTx": {
      const r = validateTx(d, msg.tx);
      if (!r.ok) return send(ws, { type: "error", ref: "submitTx", message: r.error });
      const t = r.value;
      d.stmts.insertTx.run({
        id: t.id, from_address: t.from, to_address: t.to,
        amount: t.amount, fee: t.fee, fee_rate: t.feeRate,
        memo: t.memo || null, signature: t.signature, public_key: t.publicKey,
        timestamp: t.timestamp,
      });
      const wireTx: Tx = {
        id: t.id, from: t.from, to: t.to, amount: t.amount, fee: t.fee,
        feeRate: t.feeRate, memo: t.memo, signature: t.signature,
        publicKey: t.publicKey, timestamp: t.timestamp,
      };
      gossip.broadcast({ type: "newTx", tx: wireTx });
      return send(ws, { type: "ack", ref: "submitTx", data: { id: t.id, fee: t.fee, bytes: t.bytes } });
    }

    case "submitEntry": {
      const r = validateEntry(d, msg.entry);
      if (!r.ok) return send(ws, { type: "error", ref: "submitEntry", message: r.error });
      const e = r.value;
      const existing = d.stmts.getExistingEntry.get(e.address, e.block_height);
      const finalScore = Math.max(e.score, existing?.score ?? 0);
      const isNewBest = finalScore === e.score;
      d.stmts.upsertEntry.run({
        address: e.address,
        block_height: e.block_height,
        score: finalScore,
        block_seed: e.block_seed,
        signature: e.signature,
        inputs: isNewBest ? e.inputs : null,
        inputs_hash: isNewBest ? e.inputs_hash : null,
        frame_count: isNewBest ? e.frame_count : null,
      });
      d.stmts.upsertAddress.run({
        address: e.address,
        public_key: e.publicKey,
        last_active: Date.now(),
      });
      gossip.broadcast({
        type: "newEntry",
        entry: {
          address: e.address,
          score: finalScore,
          block_height: e.block_height,
          block_seed: e.block_seed,
          signature: e.signature,
        },
      });
      return send(ws, { type: "ack", ref: "submitEntry", data: { score: finalScore, verified: true } });
    }
  }
}

// ── Block sealer ────────────────────────────────────────────────────────
// Runs every few seconds and tries to seal the next block when:
//   1. The 120s window since the previous block has elapsed.
//   2. There is at least one verified mining entry for the active height.
// This mirrors the proof-of-gaming rule: no players → no settlement.
const SEAL_TICK_MS = 5_000;

function trySealNextBlock(): boolean {
  const tip = d.stmts.getTip.get();
  const prevHeight = tip?.height ?? 0;
  const target = prevHeight + 1;
  const wall = currentHeight();
  if (target > wall) return false;

  const previousHash = tip?.hash ?? GENESIS_HASH;
  const prevTs = tip?.timestamp ?? GENESIS_TIME_MS;
  const elapsedMs = Date.now() - prevTs;
  if (elapsedMs < BLOCK_TIME_SECONDS * 1000) return false;

  const entries = d.stmts.getEntriesForHeight.all(target).map((r) => ({
    address: r.address, score: r.score, signature: r.signature,
  }));
  if (entries.length === 0) return false;

  const seed = seedForHeight(target);
  const winner = pickWinner(entries, seed);

  // Pack mempool by fee priority, capped at MAX_BLOCK_SIZE.
  const HEADER_OVERHEAD = 10_000;
  const txs: Tx[] = [];
  if (winner) {
    let used = HEADER_OVERHEAD;
    for (const r of d.stmts.getMempool.all()) {
      const t = rowToTx(r);
      const sz = JSON.stringify(t).length;
      if (sz > MAX_TX_SIZE) continue;
      if (used + sz > MAX_BLOCK_SIZE) break;
      txs.push(t);
      used += sz;
    }
  }

  const baseReward = getRewardForHeight(target);
  const feeTotal = txs.reduce((s, t) => s + (Number(t.fee) || 0), 0);
  const prevSupply = tip?.total_supply ?? 0;
  const remainingIssuance = Math.max(0, MAX_SUPPLY - prevSupply);
  const coinbase = winner ? Math.min(baseReward, remainingIssuance) : 0;
  const reward = winner ? to8(coinbase + feeTotal) : 0;
  const newSupply = to8(prevSupply + coinbase);

  const timestamp = Date.now();
  const winnerScore = Number(winner?.score ?? 0);
  const seedStr = String(target);
  const hash = computeBlockHash({
    height: target, previousHash, timestamp,
    winner: winner?.address ?? null, winnerScore,
    reward, seed: seedStr, txCount: txs.length,
  });

  const block: Block = {
    height: target,
    previousHash,
    timestamp,
    transactions: txs,
    miningEntries: entries,
    winner: winner?.address ?? null,
    winnerScore,
    reward,
    seed: seedStr,
    hash,
    totalSupply: newSupply,
    nodeCount: 1,
  };

  // Single SQLite transaction: insert block + clear mempool atomically.
  const tx = d.db.transaction(() => {
    d.stmts.insertBlock.run({
      height: block.height,
      previous_hash: block.previousHash,
      timestamp: block.timestamp,
      transactions: JSON.stringify(block.transactions),
      mining_entries: JSON.stringify(block.miningEntries),
      winner: block.winner,
      winner_score: block.winnerScore,
      reward: block.reward,
      seed: block.seed,
      hash: block.hash,
      total_supply: block.totalSupply,
      node_count: block.nodeCount,
    });
    for (const t of txs) d.stmts.deleteTxs.run(t.id);
  });
  tx();

  log("info", `sealed block #${target}`, {
    winner: block.winner, reward, txs: txs.length, hash: hash.slice(0, 12),
  });
  const newBlockMsg: ServerMsg = { type: "newBlock", block };
  gossip.broadcast(newBlockMsg);
  // Also push the new tip so non-subscribers polling getChainTip stay fresh.
  gossip.broadcast({ type: "chainTip", tip: chainTip() });
  return true;
}

const sealerHandle = setInterval(() => {
  try {
    // Loop in case we're catching up multiple windows after downtime.
    let safety = 10;
    while (safety-- > 0 && trySealNextBlock()) { /* keep sealing */ }
  } catch (e) {
    log("error", "sealer crashed", { err: String(e) });
  }
}, SEAL_TICK_MS);

// ── Graceful shutdown ───────────────────────────────────────────────────
function shutdown(signal: string) {
  log("info", `${signal} received — shutting down`);
  clearInterval(sealerHandle);
  for (const ws of wss.clients) {
    try { ws.close(1001, "server shutdown"); } catch { /* ignore */ }
  }
  wss.close();
  httpServer.close(() => {
    d.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
