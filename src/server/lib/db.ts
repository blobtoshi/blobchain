// SQLite schema bootstrap and prepared statements.
// Schema mirrors the Supabase tables so a future migration tool could replay
// historical blocks into a fresh full-node DB.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Block, Tx, Entry } from "../wsProtocol.js";

export type DB = ReturnType<typeof openDb>;

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      height        INTEGER PRIMARY KEY,
      previous_hash TEXT NOT NULL,
      timestamp     INTEGER NOT NULL,
      transactions  TEXT NOT NULL,
      mining_entries TEXT NOT NULL,
      winner        TEXT,
      winner_score  INTEGER NOT NULL DEFAULT 0,
      reward        REAL NOT NULL DEFAULT 0,
      seed          TEXT NOT NULL,
      hash          TEXT NOT NULL UNIQUE,
      total_supply  REAL NOT NULL DEFAULT 0,
      node_count    INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS mempool (
      id           TEXT PRIMARY KEY,
      from_address TEXT NOT NULL,
      to_address   TEXT NOT NULL,
      amount       REAL NOT NULL,
      fee          REAL NOT NULL,
      fee_rate     INTEGER NOT NULL,
      memo         TEXT,
      signature    TEXT NOT NULL,
      public_key   TEXT NOT NULL,
      timestamp    INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS mempool_from_idx ON mempool(from_address);
    CREATE INDEX IF NOT EXISTS mempool_fee_rate_idx ON mempool(fee_rate DESC, timestamp ASC);

    CREATE TABLE IF NOT EXISTS entries (
      address       TEXT NOT NULL,
      block_height  INTEGER NOT NULL,
      score         INTEGER NOT NULL,
      block_seed    TEXT NOT NULL,
      signature     TEXT NOT NULL,
      inputs        TEXT,
      inputs_hash   TEXT,
      frame_count   INTEGER,
      PRIMARY KEY (address, block_height)
    );
    CREATE INDEX IF NOT EXISTS entries_height_idx ON entries(block_height);

    CREATE TABLE IF NOT EXISTS addresses (
      address     TEXT PRIMARY KEY,
      public_key  TEXT,
      first_seen  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
      last_active INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
  `);

  // ── Prepared statements ───────────────────────────────────────────────
  const stmts = {
    insertBlock: db.prepare(`
      INSERT OR IGNORE INTO blocks
      (height, previous_hash, timestamp, transactions, mining_entries,
       winner, winner_score, reward, seed, hash, total_supply, node_count)
      VALUES
      (@height, @previous_hash, @timestamp, @transactions, @mining_entries,
       @winner, @winner_score, @reward, @seed, @hash, @total_supply, @node_count)
    `),
    getTip: db.prepare<[], {
      height: number; hash: string; total_supply: number; timestamp: number;
    }>(`
      SELECT height, hash, total_supply, timestamp
      FROM blocks ORDER BY height DESC LIMIT 1
    `),
    getBlocksFrom: db.prepare<[number, number], BlockRow>(
      `SELECT * FROM blocks WHERE height >= ? ORDER BY height ASC LIMIT ?`,
    ),
    getBlockByHeight: db.prepare<[number], BlockRow>(
      `SELECT * FROM blocks WHERE height = ?`,
    ),
    insertTx: db.prepare(`
      INSERT OR IGNORE INTO mempool
      (id, from_address, to_address, amount, fee, fee_rate, memo,
       signature, public_key, timestamp, status)
      VALUES
      (@id, @from_address, @to_address, @amount, @fee, @fee_rate, @memo,
       @signature, @public_key, @timestamp, 'pending')
    `),
    getMempool: db.prepare<[], MempoolRow>(
      `SELECT * FROM mempool ORDER BY fee_rate DESC, timestamp ASC LIMIT 5000`,
    ),
    getMempoolForAddress: db.prepare<[string], MempoolRow>(
      `SELECT * FROM mempool WHERE from_address = ?`,
    ),
    countMempool: db.prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM mempool`,
    ),
    deleteTxs: db.prepare<[string]>(`DELETE FROM mempool WHERE id = ?`),

    upsertEntry: db.prepare(`
      INSERT INTO entries
      (address, block_height, score, block_seed, signature, inputs, inputs_hash, frame_count)
      VALUES
      (@address, @block_height, @score, @block_seed, @signature, @inputs, @inputs_hash, @frame_count)
      ON CONFLICT(address, block_height) DO UPDATE SET
        score        = MAX(entries.score, excluded.score),
        signature    = CASE WHEN excluded.score >= entries.score THEN excluded.signature    ELSE entries.signature END,
        inputs       = CASE WHEN excluded.score >= entries.score THEN excluded.inputs       ELSE entries.inputs END,
        inputs_hash  = CASE WHEN excluded.score >= entries.score THEN excluded.inputs_hash  ELSE entries.inputs_hash END,
        frame_count  = CASE WHEN excluded.score >= entries.score THEN excluded.frame_count  ELSE entries.frame_count END,
        block_seed   = excluded.block_seed
    `),
    getEntriesForHeight: db.prepare<[number], EntryRow>(
      `SELECT * FROM entries WHERE block_height = ?`,
    ),
    getExistingEntry: db.prepare<[string, number], { score: number }>(
      `SELECT score FROM entries WHERE address = ? AND block_height = ?`,
    ),

    upsertAddress: db.prepare(`
      INSERT INTO addresses (address, public_key, last_active)
      VALUES (@address, @public_key, @last_active)
      ON CONFLICT(address) DO UPDATE SET
        public_key  = COALESCE(excluded.public_key, addresses.public_key),
        last_active = excluded.last_active
    `),
  };

  return { db, stmts };
}

// ── Row types ────────────────────────────────────────────────────────────
type BlockRow = {
  height: number;
  previous_hash: string;
  timestamp: number;
  transactions: string;
  mining_entries: string;
  winner: string | null;
  winner_score: number;
  reward: number;
  seed: string;
  hash: string;
  total_supply: number;
  node_count: number;
};

type MempoolRow = {
  id: string;
  from_address: string;
  to_address: string;
  amount: number;
  fee: number;
  fee_rate: number;
  memo: string | null;
  signature: string;
  public_key: string;
  timestamp: number;
  status: string;
};

type EntryRow = {
  address: string;
  block_height: number;
  score: number;
  block_seed: string;
  signature: string;
  inputs: string | null;
  inputs_hash: string | null;
  frame_count: number | null;
};

// ── Row → wire converters ────────────────────────────────────────────────
export function rowToBlock(r: BlockRow): Block {
  return {
    height: r.height,
    previousHash: r.previous_hash,
    timestamp: r.timestamp,
    transactions: safeParse<Tx[]>(r.transactions, []),
    miningEntries: safeParse<Block["miningEntries"]>(r.mining_entries, []),
    winner: r.winner,
    winnerScore: r.winner_score,
    reward: r.reward,
    seed: r.seed,
    hash: r.hash,
    totalSupply: r.total_supply,
    nodeCount: r.node_count,
  };
}

export function rowToTx(r: MempoolRow): Tx {
  return {
    id: r.id,
    from: r.from_address,
    to: r.to_address,
    amount: r.amount,
    fee: r.fee,
    feeRate: r.fee_rate,
    memo: r.memo ?? "",
    signature: r.signature,
    publicKey: r.public_key,
    timestamp: r.timestamp,
  };
}

export function rowToEntry(r: EntryRow): Entry {
  return {
    address: r.address,
    score: r.score,
    block_height: r.block_height,
    block_seed: r.block_seed,
    signature: r.signature,
    inputs: r.inputs,
    inputs_hash: r.inputs_hash,
    frame_count: r.frame_count,
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
