// BLOB CHAIN full node - Phase 3.

//

// This node:

//   - Serves HTTP REST + WebSocket /ws to wallets/desktop clients.

//   - Peers with other full nodes (outbound WS dialer) for block/tx/entry gossip.

//   - Seals blocks every 120s through the unified `ingest` chokepoint so the

//     reorg + validation logic is shared with peer-supplied blocks.



import express from "express";

import { WebSocketServer, type WebSocket } from "ws";

import { randomUUID, createHash } from "node:crypto";

import { readFileSync, existsSync } from "node:fs";

import { createServer as createHttpServer } from "node:http";

import { createServer as createHttpsServer } from "node:https";



import { openDb, rowToBlock, rowToTx, type DB } from "./lib/db.js";

import { feeInfo } from "./lib/validate.js";

import {

  BLOCK_TIME_SECONDS, GENESIS_HASH, GENESIS_TIME_MS, MAX_BLOCK_SIZE, MAX_TX_SIZE,

  MAX_SUPPLY, computeBlockHash, getRewardForHeight, pickWinner,

  runtimeSeedForHeight, to8, currentHeight,

} from "./lib/consensus.js";

import { Gossip, send } from "./lib/gossip.js";

import { ingestTx, ingestEntry, ingestBlock } from "./lib/ingest.js";

import { PeerManager } from "./lib/peers.js";

import { startUpdateChecker } from "./lib/updateCheck.js";

// Bridge intentionally not imported - runs on the website's edge functions.

import { verifySig, pubKeyToAddress } from "./lib/crypto.js";

import type {

  ChainTip, ClientMsg, ServerMsg, Block, Tx,

} from "./wsProtocol.js";

import { PROTOCOL_VERSION } from "./wsProtocol.js";



// -- Config --------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8080);

const DB_PATH = process.env.DB_PATH ?? "./data/blobchain.db";

const NODE_ID = process.env.NODE_ID ?? randomUUID();

const PEERS_RAW = process.env.PEERS ?? "";

// The public WebSocket URL where other nodes can dial back to us. If set,

// the peer manager sends peerIdentify on connect so peers can auto-mesh.

// Format: "ws://hostname:port" or "wss://hostname". Optional; if unset, this

// node receives gossip but cannot be auto-meshed (peers can still dial it

// manually via PEERS).

const SELF_URL = process.env.SELF_URL ?? "";



// -- Bootstrap -----------------------------------------------------------

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



// Hash of the current active-block commit + reveal set. Two nodes with

// identical active sets produce identical hashes; differing hashes trigger

// a full pull. Address-sorted to be order-independent.

function computeActiveStateHash(d: any, height: number): string {

  const reveals = d.stmts.getEntriesForHeight.all(height) as any[];

  const sortedReveals = [...reveals].sort((a, b) => a.address.localeCompare(b.address));

  const h = createHash("sha256");

  h.update(`h:${height}\n`);

  for (const r of sortedReveals) {

    h.update(`R|${r.address}|${r.score}|${r.signature}\n`);

  }

  return h.digest("hex");

}



function log(level: "info" | "warn" | "error", msg: string, extra?: unknown) {

  const line = { t: new Date().toISOString(), level, node: NODE_ID.slice(0, 8), msg, ...(extra ? { extra } : {}) };

  // eslint-disable-next-line no-console

  console.log(JSON.stringify(line));

}



// -- Peer manager --------------------------------------------------------

const peers = new PeerManager({

  bootstrapUrls: PEERS_RAW.split(",").map((s) => s.trim()).filter(Boolean),

  db: d,

  selfUrl: SELF_URL || undefined,

  nodeId: NODE_ID,

  log,

  onAppliedBlock: (b) => {

    // Re-broadcast peer-applied block to local subscribers.

    gossip.broadcast({ type: "newBlock", block: b });

    gossip.broadcast({ type: "chainTip", tip: chainTip() });

  },

  onAppliedTx: (msg) => gossip.broadcast(msg),

  onAppliedEntry: (msg) => gossip.broadcast(msg),

  onAppliedCommit: (msg) => gossip.broadcast(msg),

});



// -- HTTP API ------------------------------------------------------------

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

    // Block is sealed - return the entries baked into the block.

    let entries: unknown = [];

    try { entries = JSON.parse(row.mining_entries); } catch { /* keep [] */ }

    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    res.json(entries);

    return;

  }

  // Block not sealed yet - return live entries from the mempool table,

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

    pending: false,

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



app.get("/balance/:address", (req, res) => {

  const address = req.params.address;

  const row = d.stmts.getBalance.get(address);

  res.setHeader("Cache-Control", "no-store");

  res.json({ address, balance: Number(row?.balance ?? 0) });

});



// Tx history for a single address. Walks the full chain server-side using

// SQLite's json_each to scan every block's transactions list. Returns

// transfers (sent/received) plus block-reward events where this address

// was the winner. Cached at module level keyed by tip height + address so

// repeat fetches for the same address while the tip is unchanged are O(1).

app.get("/address/:address/txs", (req, res) => {

  const address = req.params.address;

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));

  const tip = d.stmts.getTip.get();

  const tipHeight = tip?.height ?? 0;

  const cacheKey = `${address}@${tipHeight}`;



  if (addrTxCache.key !== cacheKey) {

    // Pull every tx involving this address across the entire chain.

    const transferRows = d.db.prepare<[string, string], {

      height: number; timestamp: number; tx: string;

    }>(`

      SELECT b.height, b.timestamp, value AS tx

      FROM blocks b, json_each(b.transactions)

      WHERE json_extract(value, '$.from') = ? OR json_extract(value, '$.to') = ?

      ORDER BY b.height DESC

    `).all(address, address);



    // Pull every block this address won (block reward).

    const winRows = d.db.prepare<[string], {

      height: number; timestamp: number; reward: number; winner_score: number;

    }>(`

      SELECT height, timestamp, reward, winner_score

      FROM blocks WHERE winner = ? ORDER BY height DESC

    `).all(address);



    const transfers = transferRows.map((r) => {

      let parsed: any = {};

      try { parsed = JSON.parse(r.tx); } catch { /* ignore malformed */ }

      return {

        kind: "transfer" as const,

        id: parsed.id ?? "",

        from: parsed.from ?? "",

        to: parsed.to ?? "",

        amount: Number(parsed.amount ?? 0),

        fee: Number(parsed.fee ?? 0),

        feeRate: parsed.feeRate != null ? Number(parsed.feeRate) : undefined,

        memo: parsed.memo ?? "",

        signature: parsed.signature ?? "",

        timestamp: Number(parsed.timestamp ?? r.timestamp),

        block: Number(r.height),

        status: "confirmed" as const,

      };

    });



    const rewards = winRows.map((r) => ({

      kind: "reward" as const,

      id: `reward-${r.height}`,

      from: "coinbase",

      to: address,

      amount: Number(r.reward ?? 0),

      fee: 0,

      feeRate: undefined,

      memo: "",

      signature: "",

      timestamp: Number(r.timestamp),

      block: Number(r.height),

      status: "confirmed" as const,

      winnerScore: Number(r.winner_score ?? 0),

    }));



    const all = [...transfers, ...rewards].sort((a, b) => {

      if (b.block !== a.block) return b.block - a.block;

      return b.timestamp - a.timestamp;

    });

    addrTxCache = { key: cacheKey, list: all };

  }



  const out = addrTxCache.list.slice(0, limit);

  res.setHeader("Cache-Control", "no-store");

  res.setHeader("X-Total-Count", String(addrTxCache.list.length));

  res.json(out);

});

let addrTxCache: { key: string; list: any[] } = { key: "", list: [] };



app.get("/stats", (_req, res) => {

  const tip = d.stmts.getTip.get();

  const totalTxs = d.db.prepare<[], { c: number }>(

    `SELECT COALESCE(SUM(json_array_length(transactions)), 0) AS c FROM blocks`

  ).get()?.c ?? 0;

  res.setHeader("Cache-Control", "no-store");

  res.json({

    height: tip?.height ?? 0,

    totalSupply: Number(tip?.total_supply ?? 0),

    totalTxs: Number(totalTxs),

  });

});



// -- Address registry ----------------------------------------------------

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

  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));

  const offset = Math.max(0, Number(req.query.offset) || 0);



  // Derive addresses from on-chain history - every winner, every tx from/to.

  // This is the canonical "blockchain semantics" - an address exists if it

  // has appeared in any block. Cached at module level keyed by tip height

  // so we don't rescan the whole chain on every request.

  const tip = d.stmts.getTip.get();

  const tipHeight = tip?.height ?? 0;



  if (addressCache.tipHeight !== tipHeight) {

    const allBlocks = d.db.prepare<[], {

      height: number; timestamp: number; winner: string | null;

      winner_score: number; reward: number; transactions: string;

    }>(`SELECT height, timestamp, winner, winner_score, reward, transactions FROM blocks ORDER BY height ASC`).all();



    type Agg = {

      address: string;

      blocksWon: number;

      totalMined: number;

      bestScore: number;

      txCount: number;

      firstSeen: number;

      lastActive: number;

    };

    const map = new Map<string, Agg>();

    const touch = (addr: string, ts: number) => {

      const ex = map.get(addr);

      if (!ex) {

        map.set(addr, {

          address: addr, blocksWon: 0, totalMined: 0, bestScore: 0,

          txCount: 0, firstSeen: ts, lastActive: ts,

        });

        return map.get(addr)!;

      }

      if (ts < ex.firstSeen)  ex.firstSeen  = ts;

      if (ts > ex.lastActive) ex.lastActive = ts;

      return ex;

    };



    for (const b of allBlocks) {

      if (b.winner) {

        const a = touch(b.winner, b.timestamp);

        a.blocksWon  += 1;

        a.totalMined += Number(b.reward ?? 0);

        if (Number(b.winner_score ?? 0) > a.bestScore) a.bestScore = Number(b.winner_score);

      }

      let txs: any[] = [];

      try { txs = JSON.parse(b.transactions); } catch { /* ignore */ }

      for (const t of txs) {

        if (t?.from && t.from !== "coinbase") {

          const a = touch(String(t.from), Number(t.timestamp ?? b.timestamp));

          a.txCount += 1;

        }

        if (t?.to) {

          const a = touch(String(t.to), Number(t.timestamp ?? b.timestamp));

          a.txCount += 1;

        }

      }

    }



    // Best score from entries table covers players who never won.

    const entryStmt = d.db.prepare<[], { address: string; best_entry: number }>(

      `SELECT address, MAX(score) AS best_entry FROM entries GROUP BY address`,

    );

    for (const r of entryStmt.all()) {

      const a = map.get(r.address);

      if (a && Number(r.best_entry ?? 0) > a.bestScore) a.bestScore = Number(r.best_entry);

    }



    addressCache = {

      tipHeight,

      list: [...map.values()].sort((a, b) => a.firstSeen - b.firstSeen),

    };

  }



  const total = addressCache.list.length;

  const slice = addressCache.list.slice(offset, offset + limit);

  const out = slice.map((a) => ({

    address: a.address,

    publicKey: null,

    blocksWon: a.blocksWon,

    totalMined: a.totalMined,

    balance: 0,

    bestScore: a.bestScore,

    gamesPlayed: 0,

    firstSeen: new Date(a.firstSeen).toISOString(),

    lastActive: new Date(a.lastActive).toISOString(),

  }));



  // Fill balance + gamesPlayed per address (cheap loops, only for the page).

  const balStmt = d.db.prepare<[string], { balance: number }>(

    `SELECT balance FROM balances WHERE address = ?`,

  );

  const gameStmt = d.db.prepare<[string], { games_played: number; best_entry: number }>(`

    SELECT COUNT(DISTINCT block_height) AS games_played,

           COALESCE(MAX(score), 0) AS best_entry

    FROM entries WHERE address = ?`);

  for (let i = 0; i < out.length; i++) {

    const b = balStmt.get(out[i].address);

    out[i].balance = Number(b?.balance ?? 0);

    const g = gameStmt.get(out[i].address);

    out[i].gamesPlayed = Number(g?.games_played ?? 0);

    if (Number(g?.best_entry ?? 0) > out[i].bestScore) out[i].bestScore = Number(g.best_entry);

  }



  res.setHeader("Cache-Control", "no-store");

  res.setHeader("X-Total-Count", String(total));

  res.json(out);

});



// Module-scoped cache for /addresses derivation. Invalidated on tip change.

let addressCache: {

  tipHeight: number;

  list: Array<{

    address: string;

    blocksWon: number;

    totalMined: number;

    bestScore: number;

    txCount: number;

    firstSeen: number;

    lastActive: number;

  }>;

} = { tipHeight: -1, list: [] };







// -- Bridge endpoints removed --------------------------------------------

// The Solana bridge is custodial and lives on the website (Supabase edge

// functions), not on full nodes. Wallets should hit the website directly

// for /bridge/* operations.



// -- WebSocket API -------------------------------------------------------

const TLS_CERT = process.env.TLS_CERT_PATH ?? "";

const TLS_KEY = process.env.TLS_KEY_PATH ?? "";

const useTls = !!(TLS_CERT && TLS_KEY && existsSync(TLS_CERT) && existsSync(TLS_KEY));

const httpServer = useTls

  ? createHttpsServer(

      { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) },

      app

    )

  : createHttpServer(app);

httpServer.listen(PORT, () => {

  log("info", `full node listening on ${useTls ? "https" : "http"}://0.0.0.0:${PORT}`, {

    dbPath: DB_PATH, nodeId: NODE_ID, peers: PEERS_RAW || "(none)", tls: useTls,

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



    case "peerIdentify": {

      // Auto-mesh: a peer node has dialed us and is telling us their public

      // URL so we can dial them back. We add the URL to our outbound peer

      // set, idempotently. If we already have an outbound connection to

      // them, the peer manager ignores the request.

      //

      // Identifying themselves via this message is just an optimisation;

      // they're already a regular subscriber via their dial+subscribe so

      // gossip already flows them->us. The dial-back lets gossip flow

      // us->them so the mesh becomes bidirectional.

      if (msg.peerUrl && msg.nodeId !== NODE_ID) {

        peers.addPeer(msg.peerUrl);

      }

      return send(ws, { type: "ack", ref: "peerIdentify" });

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



    case "getActiveEntries": {

      // Snapshot pull of all entries for a given height. Used by peers when

      // they first connect (to converge the active block set) and by browser

      // clients to populate the UI immediately. Phase 6: commits no longer

      // exist; we ship the full SubmitEntryPayload-shaped reveal so peers

      // can re-validate via ingestEntry.

      const h = Math.max(1, msg.height | 0);

      const reveals = d.stmts.getEntriesForHeight.all(h).map((e: any) => ({

        address: e.address,

        score: Number(e.score ?? 0),

        block_height: e.block_height,

        block_seed: e.block_seed,

        signature: e.signature,

        inputs: e.inputs ?? null,

        inputs_hash: e.inputs_hash ?? null,

        frame_count: e.frame_count ?? null,

        engine_version: 1,

        pow_nonce: e.pow_nonce ?? null,

        publicKey: e.public_key ?? null,

      }));

      return send(ws, { type: "activeEntries", height: h, commits: [], reveals });

    }



    case "activeStateHash": {

      // Periodic state-sync probe: peer sends us their active-set hash for a

      // given height. If it differs from ours, we pull their full set so we

      // converge. (We don't bother replying - they'll do the same on their

      // own probe tick if our hash differs from theirs.)

      const h = msg.height | 0;

      const localHash = computeActiveStateHash(d, h);

      if (localHash !== msg.hash) {

        send(ws, { type: "getActiveEntries", height: h } as any);

      }

      return;

    }



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

      // Phase 6: single-shot entry submission (replaces commit-reveal).

      // Validates fully (signature + PoW + window + simulator), upserts

      // best-score per address per block, then gossips the full payload

      // to local subscribers AND to peer nodes so every node converges

      // on the same entry set before the seal tick.

      const r = ingestEntry(d, msg.entry);

      if (!r.ok) {

        log("warn", "submitEntry rejected", {

          err: r.error,

          address: msg.entry?.address,

          block_height: msg.entry?.block_height,

          score: msg.entry?.score,

        });

        return send(ws, { type: "error", ref: "submitEntry", message: r.error });

      }

      if (r.isNewBest) {

        const fullMsg: ServerMsg = {

          type: "newEntry",

          entry: {

            address: r.address, score: r.score,

            block_height: r.block_height, block_seed: r.block_seed,

            signature: r.signature,

            inputs: msg.entry.inputs,

            inputs_hash: msg.entry.inputs_hash,

            frame_count: msg.entry.frame_count,

            engine_version: msg.entry.engine_version,

            pow_nonce: msg.entry.pow_nonce,

            publicKey: msg.entry.publicKey,

          },

        };

        gossip.broadcast(fullMsg);

        peers.broadcast(fullMsg);

      }

      return send(ws, {

        type: "ack", ref: "submitEntry",

        data: { score: r.score, isNewBest: r.isNewBest },

      });

    }



    case "submitEntryCommit": {

      // Phase 6: commit-reveal split is gone. Reject with a clear message

      // pointing the client to the new single-shot flow.

      return send(ws, {

        type: "error", ref: "submitEntryCommit",

        message: "commit-reveal flow removed in protocol v2 - use submitEntry",

      });

    }



    case "submitEntryReveal": {

      return send(ws, {

        type: "error", ref: "submitEntryReveal",

        message: "commit-reveal flow removed in protocol v2 - use submitEntry",

      });

    }

  }

}



// -- Block sealer --------------------------------------------------------

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



// Phase 5: every 10 seconds, probe peers with our active-set hash so any

// missed gossip messages get healed before sealing time. Cheap: one 32-byte

// hash per peer per 10s, and only triggers a full pull when hashes diverge.

const STATE_SYNC_TICK_MS = 10_000;

const stateSyncHandle = setInterval(() => {

  try {

    const tip = d.stmts.getTip.get();

    const activeHeight = (tip?.height ?? 0) + 1;

    const hash = computeActiveStateHash(d, activeHeight);

    peers.broadcast({ type: "activeStateHash", height: activeHeight, hash } as any);

  } catch (e) {

    log("error", "state-sync probe crashed", { err: String(e) });

  }

}, STATE_SYNC_TICK_MS);



// Bridge worker removed - bridge no longer runs on full nodes.



// -- Graceful shutdown ---------------------------------------------------

function shutdown(signal: string) {

  log("info", `${signal} received - shutting down`);

  clearInterval(sealerHandle);

  clearInterval(stateSyncHandle);

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
