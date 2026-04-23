

## Reverse Bridge — WBLOB (Solana) → BLOB (Blob Chain)

Mirror image of the forward bridge: user burns WBLOB on Solana with a memo encoding their Blob address; the backend detects the burn, deducts a small bridge fee, and credits BLOB to the destination wallet on the next sealed block.

### User flow

1. User opens the Bridge screen → picks the **"WBLOB → BLOB"** tab.
2. Enters their **Blob destination address** (validated `^1[1-9A-HJ-NP-Za-km-z]{25,34}$`) and an **amount**.
3. UI shows the preview: `You burn 10.00000000 WBLOB → You receive 9.99850000 BLOB (bridge fee 0.0015 BLOB)`.
4. User clicks **Connect wallet** (Phantom / any Solana wallet adapter) and signs **one Solana transaction** that:
   - Sends a SPL **Memo program** instruction with the payload `blob:<address>`.
   - Calls **`burn`** on the WBLOB SPL token for the chosen amount from the user's ATA.
5. Client POSTs `{ sol_signature, blob_address, amount }` to a new edge function `bridge-redeem`.
6. UI polls request status (`pending → verified → credited → failed`). On `credited`, it shows the inbound BLOB tx id and the user's balance updates on the next block.

### Backend

#### New edge function: `bridge-redeem`

- **POST** `{ sol_signature, blob_address, amount }`:
  - Validate inputs (blob address regex, amount > 0, signature base58 64-88 chars).
  - Insert a `bridge_redeems` row with status `pending`. Idempotent on `sol_signature` (unique).
  - `EdgeRuntime.waitUntil(verifyAndCredit(...))`.
- **GET** `?sol_signature=...`: returns current row; re-runs verify if still `pending`.

#### `verifyAndCredit(sig)` — the trust-critical path

1. `connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" })`.
2. Reject unless **finalized** (not `confirmed`) — prevents reorg-based double-credits.
3. Walk instructions, requiring **all** to be true:
   - Exactly one **`spl-token` `burn` (or `burnChecked`)** instruction whose `mint` equals `SOLANA_SPL_MINT_ADDRESS` and whose `amount` (in base units, converted via `mintInfo.decimals`) equals the request `amount`.
   - Exactly one **Memo program** (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) instruction whose UTF-8 data is `blob:<blob_address>` (exact match — prevents redirect attacks, same pattern as the forward bridge memo check).
   - The **fee payer / burn authority** is the same signer as the memo (sanity).
4. If anything fails → mark `failed` with reason; stop.
5. Compute credit: `credit = amount − BRIDGE_FEE_BLOB` (configurable constant, default `0.0015`). If `credit ≤ 0` → `failed: amount below bridge fee`.
6. Atomically claim: `UPDATE bridge_redeems SET status='crediting' WHERE sol_signature=? AND status='verified' RETURNING *` — guarantees single credit even with concurrent polls.
7. Issue a **server-signed credit tx** (see below) and on success update to `credited` with the `blob_tx_id` + `credited_at`.

#### Server-signed credit transactions

The bridge address `19xGuoUEng3w4Y2DjP6te2LLTSKt7fKs27` currently has no private key on the server (forward bridge only receives there). For the reverse bridge we add:

- New secret **`BRIDGE_BLOB_PRIVATE_KEY`** (hex secp256k1 key, address must equal `BRIDGE_ADDRESS`). Asked via `add_secret` before deploy.
- A small server-side signer in `bridge-redeem` that builds a normal Blob tx (`from = BRIDGE_ADDRESS`, `to = blob_address`, `amount = credit`, memo = `redeem:<sol_sig_short>`), signs it with the bridge key, and POSTs to `submit-tx`. The fee on this server-side tx comes out of the **bridge fee** we just deducted, so the user receives exactly `amount − BRIDGE_FEE_BLOB`. We size `BRIDGE_FEE_BLOB` to comfortably exceed worst-case network fee at current `recommendedFeeRate`.
- Bridge address must be funded with enough BLOB to cover outgoing redeems. Forward-bridge deposits accumulate there, so the same balance is the redemption reserve. UI warns if reserve insufficient.

### Database

New table `bridge_redeems`:

```text
sol_signature   text PK
blob_address    text         not null
amount          numeric      not null   -- WBLOB burned (= BLOB before fee)
credit_amount   numeric      null       -- amount - bridge_fee, set on verify
bridge_fee      numeric      null
status          text         not null   -- pending|verified|crediting|credited|failed
blob_tx_id      text         null       -- server-signed credit tx id
error           text         null
created_at      timestamptz  default now()
verified_at     timestamptz  null
credited_at     timestamptz  null
```

RLS: public SELECT (mirrors `bridge_requests`). All writes via service-role only.

### Frontend

- `src/components/blob/BridgeScreen.tsx`: refactor into a tabbed view — **`BLOB → WBLOB`** (existing) and **`WBLOB → BLOB`** (new sub-component `RedeemPanel`).
- New `RedeemPanel`:
  - Phantom / Solana wallet adapter integration (`@solana/wallet-adapter-react` + `-wallets` + `-react-ui`). One small provider added at the bridge route only.
  - Builds the burn+memo tx with `@solana/web3.js` and `@solana/spl-token` (`createBurnCheckedInstruction` + memo program ix).
  - Shows preview, fee, status pill, history list (filtered by `blob_address`).
- `src/lib/blobRelay.ts`: add `registerRedeem`, `pollRedeem`, `fetchRedeemHistory`, `RedeemRequest` type — same shape as the existing bridge helpers.
- `src/lib/blob/constants.ts`: add `BRIDGE_FEE_BLOB = 0.0015`, `MEMO_PROGRAM_ID`.

### Security model

- **Finalized commitment only** — prevents Solana fork rollback exploits.
- **Memo binds the destination** — the burn signer cryptographically authorises a single Blob recipient. No mempool watcher can redirect (same defense as the forward `sol:` memo fix).
- **Idempotent on `sol_signature`** + `status='verified'` claim — credits exactly once even under polling races.
- **Bridge BLOB key** lives only as a Supabase secret; never leaves the edge function.
- **Amount + mint must both match** — prevents burns of unrelated tokens or wrong amounts being honoured.

### Out of scope

- Cross-chain liquidity rebalancing (keeping bridge BLOB reserve topped up automatically).
- Refund flow for `failed` redemptions (manual ops for now; the burn cannot be undone by the bridge).
- Replacing Phantom-only with a generic wallet picker — adapter setup ships with Phantom + Solflare, can extend later.

### Required from you

Before deploy I'll prompt for:
- **`BRIDGE_BLOB_PRIVATE_KEY`** — secp256k1 private key (hex) for `19xGuoUEng3w4Y2DjP6te2LLTSKt7fKs27`. Without it the server can't issue credit txs.

