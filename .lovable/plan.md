# Consensus & bridge hardening

Six independent changes. They touch the node, the simulator, the website, and the bridge edge function. Bumping `ENGINE_VERSION` from `2` → `3` once because the simulator's input contract changes (commit-reveal adds a per-run salt).

---

## 1. Bot-friendly blinded level seeds (anti-grinding, ML still works)

**Goal:** stop offline level pre-solving (you can't pre-compute the obstacle layout for height H), while keeping the game playable in real time so ML inference bots can compete fairly with humans.

**Mechanism: late-bound seed split.**

Today the entire level for height H is generated from `seedForHeight(H)`, which is a pure function of H. Anyone can pre-compute the full obstacle list 24 hours in advance and run an offline solver.

We split the seed into two parts:

```
runtime_seed = mix( seedForHeight(H), reveal_beacon(H) )
```

- `seedForHeight(H)` — same as today, public from genesis. Used **only** for cosmetic background, not for obstacles.
- `reveal_beacon(H)` — a value that is *not* known until the block window for H opens. Two viable sources, pick one:
  - **(a) Hash of the previous block's `hash**` (`reveal = sha256(prevHash || H)`). Only known once block H-1 is sealed, ~120s before H closes. Trivial to implement, fully deterministic for replay verification. Recommended.
  - **(b) VRF / drand beacon.** Stronger, but adds a dependency and an external trust assumption. Skip for now.

Going with **(a)**. The full level is now generated from `runtime_seed`, computable by anyone the instant H-1 lands but not before. Players get the full ~120 s window to react; ML bots running real-time inference are unaffected; offline brute-force solvers lose the ability to pre-solve.

**ML competitiveness:** the obstacle generator is still pure and deterministic per-frame given `runtime_seed`. A bot that observes the canvas (or, more efficiently, calls `generateLevelPure(runtime_seed)` directly the moment H-1 seals) has the same information a human does — just faster reflexes. We are **not** trying to lock bots out, we're locking out *pre-computation*.

**Files:**

- `node/lib/consensus.ts` — add `runtimeSeedForHeight(height, prevHash)`.
- `node/lib/simulator.ts`, `src/lib/blob/simulator.ts` — `generateLevelPure` already takes a seed; the caller now passes `runtime_seed` instead of `seedForHeight(H)`.
- `node/lib/validate.ts` — `validateEntry` recomputes `runtime_seed` from the canonical prev hash and checks it matches the `block_seed` field the client submitted. Reject entries whose `block_seed` doesn't match.
- `src/hooks/useBlockchain.ts`, `src/components/blob/BlobRunGame.tsx`, `src/components/blob/MineHero.tsx` — derive `blockInfo.seed` from `chain.tip.hash` (already in state) instead of pure height.
- Genesis: `seedForHeight(1)` becomes the runtime seed for height 1 (no prev block to mix with).

---

## 2. Sybil resistance: per-entry proof-of-work

**Goal:** stop one operator from spamming thousands of low-score entries from disposable addresses to dilute honest players' lottery weight.

**What "small PoW" entails:**
A PoW is "find a nonce `N` such that `sha256(payload || N)` starts with `D` zero bits." The submitter spends CPU; verifiers spend ~one hash. We pick `D` so that:

- A real player on a phone produces a valid nonce in **~1–3 seconds** (negligible — the game itself takes 60+ s).
- An attacker spinning up 10,000 fake entries pays 10,000 × that cost (≈ several CPU-hours) per block, every block. That kills the economics of dilution attacks while staying invisible to honest users.

Concretely: `D = 18` zero bits ≈ ~262k SHA-256 attempts ≈ ~0.5 s on a laptop, ~1.5 s on a low-end phone. We also bind the PoW to the height + address + inputs_hash so a nonce can't be reused across heights, addresses, or runs.

```
pow_payload = `${block_height}:${address}:${inputs_hash}:${nonce}`
require: sha256(pow_payload) has ≥ 18 leading zero bits
```

**Files:**

- `node/lib/consensus.ts` — export `ENTRY_POW_BITS = 18` and a `verifyEntryPow(payload, nonce, bits)` helper.
- `node/lib/validate.ts` — `validateEntry` checks PoW before the (expensive) replay simulation. Cheap reject path.
- `node/wsProtocol.ts`, `src/lib/wsProtocol.ts` — add `pow_nonce: string` to `SubmitEntryPayload`.
- `src/components/blob/BlobRunGame.tsx` — after the run ends, mine the nonce in a Web Worker (off the main thread) before signing & submitting. UI shows a brief "Sealing entry…" state.
- Re-export from `src/lib/blob/` so the desktop app gets it for free.

Per-address cap (cheap belt-and-braces): also reject more than 1 winning entry per address per height (already enforced by the `(address, block_height)` PK in the entries table — keep it).

---

## 3. Commit-reveal on entries (anti-snipe / anti-copy)

**Goal:** prevent a node operator from watching incoming entries near the deadline, copying the highest-scoring inputs trace, re-signing it under their own address, and submitting it at T-50 ms to win the lottery weighting.

**Two-phase flow per height H:**

```text
T-120s ──────────────── T-30s ─────── T-0 ─────── T-0+30s
   COMMIT WINDOW           │  REVEAL WINDOW   │
   (accept commits)        │  (accept reveals)│
                           ▼                  ▼
                    commits frozen     block sealed
```

- **Commit (any time during the window):** client posts `{ address, block_height, commit_hash, pow_nonce, signature }`, where `commit_hash = sha256(score || inputs_hash || salt)`. No score is revealed yet. PoW (item 2) gates this submission.
- **Reveal (last 30 s of the window):** client posts the full `{ score, inputs, inputs_hash, frame_count, salt, signature }`. Validator checks: PoW commit exists for this `(address, height)`, `sha256(score||inputs_hash||salt) === stored commit_hash`, then runs the deterministic replay as today.
- **Sealing rule:** `pickWinner` only considers entries whose commit was received **before** the reveal window opened. A late-arriving "copy" of someone else's trace cannot win because no matching commit exists.

**Why this works:** the attacker never sees the inputs trace until reveal time, and by then commits are frozen. The only way to win with a copied trace is to predict the score in advance, which is the same as solving the level honestly.

**Files:**

- `node/lib/db.ts` — new `entry_commits` table: `(address, block_height, commit_hash, pow_nonce, signature, received_at)` PK `(address, block_height)`.
- `node/lib/ingest.ts` — split `ingestEntry` into `ingestEntryCommit` and `ingestEntryReveal`.
- `node/lib/validate.ts` — two new validators; reveal validator checks the commit exists and was received before `windowOpenTs - 30s`.
- `node/wsProtocol.ts` — new message types `submitEntryCommit` and `submitEntryReveal`.
- `node/full-node.ts` — wire the two messages; sealer continues to read from the `entries` table (populated only on successful reveal).
- `src/components/blob/BlobRunGame.tsx`, `src/lib/blobRelay.ts`, `src/hooks/useBlockchain.ts` — game posts commit immediately after the run dies, posts reveal when the reveal window opens. Per-run `salt` is a random 16-byte value generated client-side.
- `src/lib/blob/simulator.ts` — `ENGINE_VERSION` bumps `2` → `3` because the entry payload format changes.

---

## 4. Tighter timestamp window for tie-break

**Goal:** make depth-1 reorg manipulation harder by shrinking the future-timestamp tolerance.

Today (`node/lib/ingest.ts:151`):

```ts
if (block.timestamp > Date.now() + 60_000) return { error: "block from the future" };
```

60 s of future skew gives an attacker 60 s of timestamp grinding per height to find a hash that beats the honest block in the lex-tie-break.

**Changes:**

- Drop future tolerance from **60 s → 5 s** (clock skew between well-synced nodes is ≤ 1 s; 5 s is very generous).
- Drop minimum spacing from `prev + BLOCK_TIME` to `prev + BLOCK_TIME - 2_000` to allow tiny clock drift, no more.
- Replace the lex tie-break with a **deterministic** tie-break that the attacker can't grind: `tieKey = sha256(block.hash || seedForHeight(height) || prevHash)`. Lower `tieKey` wins. Because `seedForHeight` and `prevHash` are fixed, the attacker still has to grind, but now they're grinding sha256 of a hash they can't trivially shape — same as PoW mining, with no payoff because the work isn't recognized as security.

Also: reject any block whose `timestamp < prev.timestamp + BLOCK_TIME * 1000 - 2_000` (the existing check, just tightened).

**Files:** `node/lib/ingest.ts` only.

---

## 5. Materialized balance index (fix calcBalance O(n) full scan)

**Goal:** stop scanning every block of history on every tx submit.

**Approach:** maintain a `balances` table updated atomically with every `insertBlock` and `deleteTxs`. `calcBalance(address)` becomes a single indexed lookup + a cheap mempool delta.

```sql
CREATE TABLE balances (
  address TEXT PRIMARY KEY,
  balance REAL NOT NULL DEFAULT 0
);
CREATE INDEX balances_balance_idx ON balances(balance DESC);
```

Update rules (all wrapped in the existing `ingestBlock` transaction):

- On `INSERT INTO blocks`: credit `winner` by `reward`; for each tx credit `to`, debit `from` by `amount + fee`. UPSERT each touched address.
- On reorg replace (`DELETE FROM blocks WHERE height = ?`): undo the losing block's effects in the same transaction, then apply the winning block.

**Backfill:** on startup, if the `balances` table is empty but `blocks` is not, replay the chain once into the table. One-time O(n) cost at boot.

**Pruning:** rows with `balance = 0` and zero recent activity can be GC'd after a long idle window — out of scope for this PR.

**Files:**

- `node/lib/db.ts` — schema + prepared statements (`upsertBalance`, `getBalance`, `seedBalances`).
- `node/lib/ingest.ts` — wire balance updates into `ingestBlock` (append + replace paths).
- `node/lib/validate.ts` — `calcBalance` reads from the new table; mempool delta computed as today.
- `node/full-node.ts` — call `seedBalances(d)` once at startup if the table is empty.

---

## 6. Bridge confirmations (anti-double-spend on redeem)

**Goal:** the reverse bridge currently credits BLOB the moment the burn tx is `finalized` on Solana (one of Solana's stronger commitments). Solana finality is strong, but for symmetry with the forward direction and to be visibly conservative, require **N = 3 finalized confirmations** (≈ 5–10 s additional wait beyond finality) before crediting.

Note: "confirmations" on Solana ≠ Bitcoin blocks. We define one "confirmation" as `currentSlot - tx.slot >= 32` (one epoch boundary), and require `≥ 96` slots (~40 s) before credit. This is our N=3 in user-friendly language.

**Server (`supabase/functions/bridge-redeem/index.ts`):**

- After `verifyBurn` succeeds, fetch `getSlot({commitment: "finalized"})` and the tx's slot from the receipt.
- If `currentSlot - txSlot < 96`, leave the row as `verified` and bail; the next poll re-runs and eventually crosses the threshold.
- Add a `confirmations` field (computed `floor((currentSlot - txSlot) / 32)`, capped at 3) to the row response so the UI can show progress.

**DB (`bridge_redeems`):** add a nullable `confirmations` integer column. Migration only.

**UI (`src/components/blob/RedeemPanel.tsx`):**

- Add a new status pill state: **"Awaiting network confirmations (1/3)"**, "(2/3)", "(3/3)".
- Banner under the burn submission: *"Your burn is confirmed on Solana. We wait for 3 network confirmations (~40 seconds) before crediting BLOB to keep the bridge safe."*
- The existing `verifying` state covers this; we just add the count to the label.

**Files:**

- `supabase/functions/bridge-redeem/index.ts`
- `src/components/blob/RedeemPanel.tsx`
- `src/lib/blobRelay.ts` (`RedeemRequest` type gets `confirmations?: number`)
- New SQL migration adding the `confirmations` column.

---

## Order of implementation & rollout

Do these in a single coordinated push because items 1, 2, 3 all touch entry validation and we don't want intermediate states forking the chain:

1. Schema migration (balances table, entry_commits table, bridge_redeems.confirmations column). One migration file.
2. `node/lib/consensus.ts` — `runtimeSeedForHeight`, `ENTRY_POW_BITS`, `verifyEntryPow`. Bump `ENGINE_VERSION` to 3.
3. `node/lib/db.ts`, `node/lib/ingest.ts`, `node/lib/validate.ts` — commit-reveal split, balance index, tighter timestamps.
4. `node/full-node.ts` — wire new WS messages, call `seedBalances` on boot.
5. Client: `src/lib/blob/simulator.ts` (engine v3), `BlobRunGame.tsx` (PoW worker + commit-reveal flow), `useBlockchain.ts`, `MineHero.tsx`.
6. Bridge: edge function + UI confirmation count.
7. README updates: document the new entry flow, the PoW cost, the seed model, and the bridge confirmation policy.

After approval, I'll implement in that order and verify with a clean build.