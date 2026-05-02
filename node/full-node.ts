// BLOB CHAIN full node — Phase 3.
//
// This node:
//   • Serves HTTP REST + WebSocket /ws to wallets/desktop clients.
//   • Peers with other full nodes (outbound WS dialer) for block/tx/entry gossip.
//   • Seals blocks every 120s through the unified `ingest` chokepoint so the
//     reorg + validation logic is shared with peer-supplied blocks.

import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";

import { openDb, rowToBlock, rowToTx, type DB } from "./lib/db.js";
import { feeInfo } from "./lib/validate.js";
import {
  BLOCK_TIME_SECONDS, GENESIS_HASH, GENESIS_TIME_MS, MAX_BLOCK_SIZE, MAX_TX_SIZE,
  MAX_SUPPLY, computeBlockHash, getRewardForHeight, pickWinner,
  runtimeSeedForHeight, to8, currentHeight,
} from "./lib/consensus.js";
import { Gossip, send } from "./lib/gossip.js";
import { ingestTx, ingestEntryCommit, ingestEntryReveal, ingestBlock } from "./lib/ingest.js";
import { PeerManager } from "./lib/peers.js";
import { startUpdateChecker } from "./lib/updateCheck.js";
// Bridge intentionally not imported — runs on the website's edge functions.
import { verifySig, pubKeyToAddress } from "./lib/crypto.js";
import type {
  ChainTip, ClientMsg, ServerMsg, Block, Tx,
} from "./wsProtocol.js";
import { PROTOCOL_VERSION } from "./wsProtocol.js";

// ── Config ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8080);
const DB_PATH = process.env.DB_PATH ?? "./data/blobchain.db";
const NODE_ID = process.env.NODE_ID ?? randomUUID();
const PEERS_RAW = process.env.PEERS ?? "";

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

// ── Peer manager ────────────────────────────────────────────────────────
const peers = new PeerManager({
  bootstrapUrls: PEERS_RAW.split(",").map((s) => s.trim()).filter(Boolean),
  db: d,
  log,
  onAppliedBlock: (b) => {
    // Re-broadcast peer-applied block to local subscribers.
    gossip.broadcast({ type: "newBlock", block: b });
    gossip.broadcast({ type: "chainTip", tip: chainTip() });
  },
  onAppliedTx: (msg) => gossip.broadcast(msg),
  onAppliedEntry: (msg) => gossip.broadcast(msg),
});

// ── HTTP API ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "200kb" }));
app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});
app.options("*", (_req, res) => res.sendStatus(204));

app.get("/health", (_req, res) => {
  const tip = chainTip();
  res.json({
    ok: true,
    nodeId: NODE_ID,
    version: PROTOCOL_VERSION,
    height: tip.height,
    tipHash: tip.hash,
    peers: peers.count(),
    bridge: false,
    wallHeight: currentHeight(),
  });
});

app.get("/peers", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ count: peers.count(), peers: peers.list() });
});

app.get("/chain/tip", (req, res) => {
  const tip = chainTip();
  const etag = `"${tip.height}-${tip.hash.slice(0, 16)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  if (req.headers["if-none-match"] === etag) { res.status(304).end(); return; }
  res.json(tip);
});

app.get("/blocks", (req, res) => {
  const fromRaw = Number(req.query.from);
  const from = Number.isFinite(fromRaw) ? Math.max(0, fromRaw | 0) : 1;
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw | 0)) : 100;
  const rows = d.stmts.getBlocksFrom.all(from, limit);
  res.setHeader("Cache-Control", "no-store");
  res.json(rows.map(rowToBlock));
});

app.get("/blocks/:height", (req, res) => {
  const h = Number(req.params.height);
  if (!Number.isFinite(h) || h < 0) { res.status(400).json({ error: "invalid height" }); return; }
  const row = d.stmts.getBlockByHeight.get(h);
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.json(rowToBlock(row));
});

app.get("/blocks/:height/entries", (req, res) => {
  const h = Number(req.params.height);
  if (!Number.isFinite(h) || h < 0) { res.status(400).json({ error: "invalid height" }); return; }
  const row = d.stmts.getBlockByHeight.get(h);
  if (row) {
    // Block is sealed — return the entries baked into the block.
    let entries: unknown = [];
    try { entries = JSON.parse(row.mining_entries); } catch { /* keep [] */ }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.json(entries);
    return;
  }
  // Block not sealed yet — return live entries from the mempool table,
  // plus pending commits (revealed=0) shown with score=null so the UI can
  // surface that miners have committed without leaking their scores.
  const live = d.stmts.getEntriesForHeight.all(h);
  const revealed = new Set(live.map((r) => r.address));
  const commits = d.stmts.getCommitsForHeight.all(h)
    .filter((c) => !revealed.has(c.address));
  res.setHeader("Cache-Control", "no-store");
  res.json([
    ...live.map((r) => ({
      address: r.address,
      score: r.score,
      block_height: r.block_height,
      block_seed: r.block_seed,
      signature: r.signature,
      pending: false,
    })),
    ...commits.map((c) => ({
      address: c.address,
      score: null,
      block_height: c.block_height,
      block_seed: null,
      signature: c.signature,
      pending: true,
    })),
  ]);
});

app.get("/entries", (req, res) => {
  const h = Number(req.query.height);
  if (!Number.isFinite(h) || h < 0) { res.status(400).json({ error: "invalid height" }); return; }
  const rows = d.stmts.getEntriesForHeight.all(h);
  res.setHeader("Cache-Control", "no-store");
  res.json(rows.map((r) => ({
    address: r.address,
    score: r.score,
    block_height: r.block_height,
    block_seed: r.block_seed,
    signature: r.signature,
  })));
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

// ── Address registry ────────────────────────────────────────────────────
const ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

app.post("/addresses/register", (req, res) => {
  const { address, publicKey, signature, timestamp } = req.body ?? {};
  if (!ADDR_RE.test(String(address))) return res.status(400).json({ error: "invalid address" });
  if (!HEX_RE.test(String(publicKey))) return res.status(400).json({ error: "invalid publicKey" });
  if (!HEX_RE.test(String(signature))) return res.status(400).json({ error: "invalid signature" });
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return res.status(400).json({ error: "invalid timestamp" });
  if (Math.abs(Date.now() - ts) > 5 * 60_000) return res.status(400).json({ error: "stale timestamp" });
  // Address must derive from publicKey.
  if (pubKeyToAddress(String(publicKey)) !== String(address)) {
    return res.status(400).json({ error: "address does not match publicKey" });
  }
  // Signature is over `register:<address>:<timestamp>`.
  const msg = `register:${address}:${ts}`;
  if (!verifySig(String(publicKey), String(signature), msg)) {
    return res.status(400).json({ error: "bad signature" });
  }
  d.stmts.upsertAddress.run({ address, public_key: publicKey, last_active: Date.now() });
  res.json({ ok: true });
});

app.get("/addresses", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  // Compute aggregates on the fly. For tens of thousands of addresses this is
  // still cheap; if it ever becomes a hotspot, materialize a view.
  const rows = d.db.prepare<[number, number], {
    address: string; public_key: string | null; first_seen: number; last_active: number;
  }>(`SELECT address, public_key, first_seen, last_active FROM addresses
       ORDER BY first_seen ASC LIMIT ? OFFSET ?`).all(limit, offset);

  const winStmt = d.db.prepare<[string], { blocks_won: number; total_mined: number; best_score: number }>(`
    SELECT COUNT(*) AS blocks_won, COALESCE(SUM(reward), 0) AS total_mined,
           COALESCE(MAX(winner_score), 0) AS best_score
    FROM blocks WHERE winner = ?`);
  const gameStmt = d.db.prepare<[string], { games_played: number; best_entry: number }>(`
    SELECT COUNT(DISTINCT block_height) AS games_played,
           COALESCE(MAX(score), 0) AS best_entry
    FROM entries WHERE address = ?`);

  const out = rows.map((r) => {
    const w = winStmt.get(r.address);
    const g = gameStmt.get(r.address);
    return {
      address: r.address,
      publicKey: r.public_key,
      blocksWon: Number(w?.blocks_won ?? 0),
      totalMined: Number(w?.total_mined ?? 0),
      bestScore: Math.max(Number(w?.best_score ?? 0), Number(g?.best_entry ?? 0)),
      gamesPlayed: Number(g?.games_played ?? 0),
      firstSeen: new Date(r.first_seen).toISOString(),
      lastActive: new Date(r.last_active).toISOString(),
    };
  });
  res.setHeader("Cache-Control", "no-store");
  res.json(out);
});

// ── Bridge endpoints removed ────────────────────────────────────────────
// The Solana bridge is custodial and lives on the website (Supabase edge
// functions), not on full nodes. Wallets should hit the website directly
// for /bridge/* operations.

// ── WebSocket API ───────────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  log("info", `full node listening on :${PORT}`, {
    dbPath: DB_PATH, nodeId: NODE_ID, peers: PEERS_RAW || "(none)",
  });
  startUpdateChecker(log);
});

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

const MAX_MALFORMED = 5;
const sockState = new WeakMap<WebSocket, { strikes: number }>();

wss.on("connection", (ws) => {
  sockState.set(ws, { strikes: 0 });
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
    case "subscribe":
      gossip.subscribe(ws);
      return send(ws, { type: "ack", ref: "subscribe" });

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
      const r = ingestTx(d, msg.tx);
      if (!r.ok) return send(ws, { type: "error", ref: "submitTx", message: r.error });
      if (r.isNew) {
        gossip.broadcast({ type: "newTx", tx: r.tx });
        peers.broadcast({ type: "newTx", tx: r.tx });
      }
      return send(ws, { type: "ack", ref: "submitTx", data: { id: r.tx.id, fee: r.tx.fee, bytes: r.bytes } });
    }

    case "submitEntry": {
      // Legacy single-shot path no longer accepted post-Phase-4 hardening.
      // Clients must commit-then-reveal; PoW is required on the commit.
      return send(ws, {
        type: "error", ref: "submitEntry",
        message: "legacy submitEntry no longer accepted — upgrade client to commit-reveal",
      });
    }

case "newEntryCommit": {
  const r = ingestEntryCommit(d, msg.commit);

  if (r.ok) {
    peers.broadcast(msg);
  }

  break;
}

case "submitEntryCommit": {
  const r = ingestEntryCommit(d, msg.commit);

  if (!r.ok) {
    return send(ws, {
      type: "error",
      ref: "submitEntryCommit",
      message: r.error
    });
  }

  
  const commitMsg = {
    type: "newEntryCommit",
    commit: msg.commit
  };

  // send to connected UI clients (browser)
  gossip.broadcast(commitMsg);

  // send to other nodes 
  peers.broadcast(commitMsg);

  
  return send(ws, {
    type: "ack",
    ref: "submitEntryCommit",
    data: {
      address: r.address,
      block_height: r.block_height
    },
  });
}

case "newEntryReveal": {
  const r = ingestEntry(d, msg.entry);

  if (r.ok) {
    peers.broadcast(msg);
  }

  break;
}

    case "submitEntryReveal": {
      const r = ingestEntryReveal(d, msg.reveal);
      if (!r.ok) return send(ws, { type: "error", ref: "submitEntryReveal", message: r.error });
      const entryMsg: ServerMsg = {
        type: "newEntry",
        entry: {
          address: r.address, score: r.score,
          block_height: r.block_height, block_seed: r.block_seed,
          signature: r.signature,
        },
      };
      gossip.broadcast(entryMsg);
      peers.broadcast(entryMsg);
      return send(ws, {
        type: "ack", ref: "submitEntryReveal",
        data: { score: r.score, verified: true },
      });
    }
  }
}

// ── Block sealer ────────────────────────────────────────────────────────
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
  if (target > 1 && elapsedMs < BLOCK_TIME_SECONDS * 1000) return false;

  const entries = d.stmts.getEntriesForHeight.all(target).map((r) => ({
    address: r.address, score: r.score, signature: r.signature,
  }));
  if (entries.length === 0) return false;

  // Runtime seed is bound to the previous block's hash so attackers can't
  // pre-compute the level for a future height. Must match ingestBlock's
  // expectation byte-for-byte.
  const seedNum = runtimeSeedForHeight(target, previousHash);
  const winner = pickWinner(entries, seedNum);

  // Pack mempool by fee priority.
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
  const seedStr = String(seedNum);
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

  // Apply through ingest so the reorg/replace path is exercised uniformly
  // even on self-sealed blocks. (For a fresh appended block ingest is just
  // a validate-then-insert.)
  const r = ingestBlock(d, block);
  if (!r.ok) {
    log("warn", `self-seal rejected by ingest: ${r.error}`, { height: target });
    return false;
  }
  if (r.applied === "duplicate") return false;

  log("info", `sealed block #${target}`, {
    winner: block.winner, reward, txs: txs.length, hash: hash.slice(0, 12),
  });
  const newBlockMsg: ServerMsg = { type: "newBlock", block };
  gossip.broadcast(newBlockMsg);
  gossip.broadcast({ type: "chainTip", tip: chainTip() });
  peers.broadcast(newBlockMsg);
  return true;
}

const sealerHandle = setInterval(() => {
  try {
    let safety = 10;
    while (safety-- > 0 && trySealNextBlock()) { /* keep sealing */ }
  } catch (e) {
    log("error", "sealer crashed", { err: String(e) });
  }
}, SEAL_TICK_MS);

// Bridge worker removed — bridge no longer runs on full nodes.

// ── Graceful shutdown ───────────────────────────────────────────────────
function shutdown(signal: string) {
  log("info", `${signal} received — shutting down`);
  clearInterval(sealerHandle);
  peers.shutdown();
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
