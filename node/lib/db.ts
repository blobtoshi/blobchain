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

      nonce        TEXT,
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



    -- Phase 6: snapshot peers need PoW nonce + public key to independently

    -- re-validate entries pulled via getActiveEntries. Live gossip carries

    -- these in the message; the snapshot path reads them from here. ALTER

    -- guards run as no-ops if the column already exists.

  `);

  try { db.exec(`ALTER TABLE entries ADD COLUMN pow_nonce TEXT`); } catch { /* exists */ }

  try { db.exec(`ALTER TABLE entries ADD COLUMN public_key TEXT`); } catch { /* exists */ }
  // H2: per-sender nonce stored alongside the mempool tx (single-use across mempool+chain).
  try { db.exec(`ALTER TABLE mempool ADD COLUMN nonce TEXT`); } catch { /* exists */ }

  db.exec(`



    -- Phase 4: commit-reveal for mining entries.

    CREATE TABLE IF NOT EXISTS entry_commits (

      address       TEXT NOT NULL,

      block_height  INTEGER NOT NULL,

      commit_hash   TEXT NOT NULL,

      pow_nonce     TEXT NOT NULL,

      public_key    TEXT NOT NULL,

      signature     TEXT NOT NULL,

      received_at   INTEGER NOT NULL,

      revealed      INTEGER NOT NULL DEFAULT 0,

      PRIMARY KEY (address, block_height)

    );

    CREATE INDEX IF NOT EXISTS entry_commits_height_idx ON entry_commits(block_height);



    CREATE TABLE IF NOT EXISTS addresses (

      address     TEXT PRIMARY KEY,

      public_key  TEXT,

      first_seen  INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),

      last_active INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)

    );



    CREATE TABLE IF NOT EXISTS balances (

      address TEXT PRIMARY KEY,

      balance REAL NOT NULL DEFAULT 0

    );

    CREATE INDEX IF NOT EXISTS balances_balance_idx ON balances(balance DESC);

    -- H2: durable set of consumed (from_address, nonce) pairs. A nonce that has
    -- been mined into a block lands here so the same signed authorization can
    -- never be replayed again, even after it leaves the mempool.
    CREATE TABLE IF NOT EXISTS spent_nonces (
      from_address TEXT NOT NULL,
      nonce        TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      PRIMARY KEY (from_address, nonce)
    );

  `);



  // -- Prepared statements -----------------------------------------------

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

       signature, public_key, timestamp, nonce, status)

      VALUES

      (@id, @from_address, @to_address, @amount, @fee, @fee_rate, @memo,

       @signature, @public_key, @timestamp, @nonce, 'pending')

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

    // H2: nonce single-use checks + durable consumed set.
    getMempoolNonce: db.prepare<[string, string], { id: string }>(
      `SELECT id FROM mempool WHERE from_address = ? AND nonce = ?`,
    ),
    getSpentNonce: db.prepare<[string, string], { from_address: string }>(
      `SELECT from_address FROM spent_nonces WHERE from_address = ? AND nonce = ?`,
    ),
    insertSpentNonce: db.prepare<{ from_address: string; nonce: string; block_height: number }>(`
      INSERT OR IGNORE INTO spent_nonces (from_address, nonce, block_height)
      VALUES (@from_address, @nonce, @block_height)
    `),
    deleteSpentNonce: db.prepare<[string, string]>(
      `DELETE FROM spent_nonces WHERE from_address = ? AND nonce = ?`,
    ),



    upsertEntry: db.prepare(`

      INSERT INTO entries

      (address, block_height, score, block_seed, signature, inputs, inputs_hash, frame_count, pow_nonce, public_key)

      VALUES

      (@address, @block_height, @score, @block_seed, @signature, @inputs, @inputs_hash, @frame_count, @pow_nonce, @public_key)

      ON CONFLICT(address, block_height) DO UPDATE SET

        score        = MAX(entries.score, excluded.score),

        signature    = CASE WHEN excluded.score >= entries.score THEN excluded.signature    ELSE entries.signature END,

        inputs       = CASE WHEN excluded.score >= entries.score THEN excluded.inputs       ELSE entries.inputs END,

        inputs_hash  = CASE WHEN excluded.score >= entries.score THEN excluded.inputs_hash  ELSE entries.inputs_hash END,

        frame_count  = CASE WHEN excluded.score >= entries.score THEN excluded.frame_count  ELSE entries.frame_count END,

        pow_nonce    = CASE WHEN excluded.score >= entries.score THEN excluded.pow_nonce    ELSE entries.pow_nonce END,

        public_key   = CASE WHEN excluded.score >= entries.score THEN excluded.public_key   ELSE entries.public_key END,

        block_seed   = excluded.block_seed

    `),

    getEntriesForHeight: db.prepare<[number], EntryRow>(

      `SELECT * FROM entries WHERE block_height = ?`,

    ),

    getExistingEntry: db.prepare<[string, number], { score: number; signature: string }>(

      `SELECT score, signature FROM entries WHERE address = ? AND block_height = ?`,

    ),



    // Commit-reveal statements.

    insertCommit: db.prepare(`

      INSERT OR IGNORE INTO entry_commits

      (address, block_height, commit_hash, pow_nonce, public_key, signature, received_at)

      VALUES

      (@address, @block_height, @commit_hash, @pow_nonce, @public_key, @signature, @received_at)

    `),

    getCommit: db.prepare<[string, number], CommitRow>(

      `SELECT * FROM entry_commits WHERE address = ? AND block_height = ?`,

    ),

    getCommitsForHeight: db.prepare<[number], CommitRow>(

      `SELECT * FROM entry_commits WHERE block_height = ?`,

    ),

    markCommitRevealed: db.prepare<[string, number]>(

      `UPDATE entry_commits SET revealed = 1 WHERE address = ? AND block_height = ?`,

    ),

    deleteOldCommits: db.prepare<[number]>(

      `DELETE FROM entry_commits WHERE block_height < ?`,

    ),

    // Delete commits at a specific height that haven't been revealed and are

    // older than `before_ms`. Used by the sealer to drop abandoned commits

    // (player walked away, browser closed, etc.) so the chain doesn't stall.

    deleteStaleCommits: db.prepare<[number, number]>(

      `DELETE FROM entry_commits WHERE block_height = ? AND revealed = 0 AND received_at < ?`,

    ),



    upsertAddress: db.prepare(`

      INSERT INTO addresses (address, public_key, last_active)

      VALUES (@address, @public_key, @last_active)

      ON CONFLICT(address) DO UPDATE SET

        public_key  = COALESCE(excluded.public_key, addresses.public_key),

        last_active = excluded.last_active

    `),



    getBalance: db.prepare<[string], { balance: number }>(

      `SELECT balance FROM balances WHERE address = ?`,

    ),

    bumpBalance: db.prepare<{ address: string; delta: number }>(`

      INSERT INTO balances (address, balance) VALUES (@address, @delta)

      ON CONFLICT(address) DO UPDATE SET balance = balances.balance + excluded.balance

    `),

    countBalances: db.prepare<[], { c: number }>(

      `SELECT COUNT(*) AS c FROM balances`,

    ),

    countBlocks: db.prepare<[], { c: number }>(

      `SELECT COUNT(*) AS c FROM blocks`,

    ),

  };



  return { db, stmts };

}



/** Apply a balance delta (positive = credit, negative = debit). */

export function applyBalanceDelta(d: DB, address: string, delta: number) {

  if (!address || delta === 0) return;

  d.stmts.bumpBalance.run({ address, delta });

}



/**

 * Backfill the balances table from full chain history. Runs once on startup

 * if the balances table is empty but blocks exist (fresh upgrade).

 */

export function seedBalancesFromChain(d: DB): number {

  const have = d.stmts.countBalances.get();

  if ((have?.c ?? 0) > 0) return 0;

  const blocks = d.stmts.countBlocks.get();

  if ((blocks?.c ?? 0) === 0) return 0;



  const allBlocks = d.db.prepare<[], BlockRow>(

    `SELECT * FROM blocks ORDER BY height ASC`,

  ).all();



  const txn = d.db.transaction(() => {

    for (const b of allBlocks) {

      if (b.winner) applyBalanceDelta(d, b.winner, Number(b.reward ?? 0));

      let txs: Tx[] = [];

      try { txs = JSON.parse(b.transactions); } catch { /* ignore */ }

      for (const t of txs) {

        if (t.to)   applyBalanceDelta(d, t.to,   Number(t.amount));

        if (t.from) applyBalanceDelta(d, t.from, -(Number(t.amount) + Number(t.fee ?? 0)));
        if (t.from && (t as any).nonce) d.stmts.insertSpentNonce.run({ from_address: t.from, nonce: (t as any).nonce, block_height: Number(b.height) });

      }

    }

  });

  txn();

  return allBlocks.length;

}



// -- Row types ------------------------------------------------------------

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
  nonce: string | null;

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

  pow_nonce: string | null;

  public_key: string | null;

};



type CommitRow = {

  address: string;

  block_height: number;

  commit_hash: string;

  pow_nonce: string;

  public_key: string;

  signature: string;

  received_at: number;

  revealed: number;

};



// -- Row -> wire converters ------------------------------------------------

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
    nonce: r.nonce ?? "",

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
