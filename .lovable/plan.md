
## Mempool.space-style Mempool UI

Rebuild the **Mempool tab** inside `BlockExplorer.tsx` into a rich, real-time visualization modeled on mempool.space. All other tabs (Overview, Blocks, Transactions, Addresses) stay as-is. Network tab stays as-is.

### Layout (top → bottom)

```text
┌─────────────────────────────────────────────────────────┐
│ HEADER STRIP                                             │
│  Pending • 12 txs   Vsize • 3.4 KB / 1 MB   Fees • 0.41 │
│  Congestion bar [▓▓▓░░░░░░░] 28% Light                   │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ INCOMING / OUTGOING (last 60s)                           │
│  ↑ in: 4 tx   ↓ confirmed: 2 tx   ⌀ rate 11.2 drops/B   │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ PROJECTED BLOCKS (next 1–3 blocks)                       │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                    │
│  │ ~12 d/B │ │  ~8 d/B │ │  ~3 d/B │                    │
│  │ next    │ │ in 2    │ │ in 3    │                    │
│  │ 2.1 KB  │ │ 0.9 KB  │ │ 0.4 KB  │                    │
│  │ 7 tx    │ │ 3 tx    │ │ 2 tx    │                    │
│  └─────────┘ └─────────┘ └─────────┘                    │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ FEE HISTOGRAM (drops/B buckets)                          │
│      ▆                                                   │
│   ▆  █  ▃                                                │
│ ▂ █  █  █  ▁                                             │
│ 1  5 10 20 50 100+   ← fee-rate buckets                  │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ MEMPOOL GOGGLES — block-fill preview                     │
│  Each square = one pending tx, sized by vbytes,          │
│  colored by fee-rate bucket. Hover/tap → tx detail.      │
│  ┌──┬─┬───┬──┬─┐                                         │
│  │  │ │   │  │ │                                         │
│  └──┴─┴───┴──┴─┘                                         │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ LIVE TX STREAM (sortable: fee-rate ▼ / time / amount)    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ ●12 d/B │ 0.50 BLOB │ Bob → BigBlobba │ 42 B │5s│    │
│  │ ●10 d/B │ 1.00 BLOB │ Alice → Bob     │ 38 B │8s│    │
│  └──────────────────────────────────────────────────┘    │
│  (existing FilterPanel kept — addr / amount / sort)      │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ RECENTLY CONFIRMED (kept, condensed)                     │
└─────────────────────────────────────────────────────────┘
```

### Concrete behavior

1. **Header strip** — pending count, total vbytes (sum of `estimateTxBytes`-style sizes from existing `memoBytes`/`canonicalTxBytes` in `src/lib/blob/fees.ts`), total fees in BLOB, congestion bar driven by `vbytes / MAX_BLOCK_SIZE` matching the existing Network tab logic.

2. **In/out counters** — track tx ids seen in the last 60s using a small `useRef<Map<id, ts>>` populated from prop changes; "confirmed in last 60s" derived from `chain` slice and matched against previously-seen mempool ids.

3. **Projected blocks** — bucket `mempool` by descending `feeRate`, greedily pack into virtual blocks of `MAX_BLOCK_SIZE` bytes. Display up to 3 cards with median fee-rate, vbyte total, tx count, est. reward (sum of fees + `blockInfo.reward`). Click a card → filters the live stream to that bucket.

4. **Fee histogram** — fixed buckets `[1, 2-5, 6-10, 11-20, 21-50, 51-100, 100+]` drops/B. Pure SVG bars (no chart lib). Hover tooltip = tx count + vbytes. Bucket of the recommended fee-rate is highlighted in cyan.

5. **Mempool goggles** — flex grid; each tx is a `<button>` with `width = clamp(8, vbytes/40, 60)px`, `height = 28px`, color from a 6-step cobalt→cyan→amber→red gradient mapped to fee-rate bucket. Title attribute shows quick info; click opens the existing tx detail by reusing `setSelTx`.

6. **Live tx stream** — replaces the current pending-pool list. Adds a fee-rate column (computed from `t.feeRate ?? Math.ceil(t.fee*1e8 / vbytes)`), a vbytes column, and a sort toggle (`feeRate-desc | time-desc | amount-desc`). Existing `FilterPanel` for the mempool stays and just feeds the same list.

7. **Per-tx row enhancements** — left-edge color stripe matches the histogram bucket. Pending duration shown as live ticker (already have `setTick` pattern in NetworkView; lift the same effect into BlockExplorer for the mempool tab only so other tabs don't re-render).

8. **Empty / busy states** — when mempool is empty, show a calm "Mempool is clear · next block has no pending txs" panel with the projected-block skeleton dimmed out.

### Files touched

- `src/components/blob/BlockExplorer.tsx` — replace the `tab === "mempool"` block (~lines 593–674) with the new layout. Add small local helpers (bucketing, vbyte estimate, projected-block packer) at the top of the file or as a new sibling util.
- `src/lib/blob/explorer.ts` — add three pure helpers: `estimateMempoolTxBytes(t)`, `feeRateOf(t, bytes)`, `bucketForRate(rate)` returning `{ idx, label, color, ringClass }`. Keeps the component thin.
- `src/lib/blob/constants.ts` — add `FEE_BUCKETS = [1,5,10,20,50,100]` (read-only).

### Performance notes

- Per-second tick is **scoped to the mempool tab only** (`useEffect` mounted inside the tab branch via a small `<MempoolTab/>` sub-component) so other tabs and the rest of the app don't re-render every second.
- All derived data (`bucketed`, `projectedBlocks`, `histogram`, `goggleCells`) computed in a single `useMemo` keyed on `mempool` length + tick.

### Explicitly NOT changed

- No backend / table changes — uses only existing `blob_mempool` fields (`amount`, `fee`, `fee_rate`, `signature`, `memo`, `timestamp`, `from_address`, etc.).
- No new dependencies.
- Network tab, Wallet, Mine, Bridge, other Explorer tabs untouched.
- Existing mempool filter panel and pagination kept.
- Brand cobalt/cyan and the heavy-glass surfaces stay; new mempool panels use existing `glass` / `glass-hi` utilities.

### Verification after apply

At 414×646 mobile and desktop, with the live testnet (currently 1 chain row, mempool empty):
- Empty state renders cleanly.
- Manually broadcast a tx via Send → projected-block card appears, histogram bucket fills, goggle cell appears, live row shows ticking pending duration.
- Block seal → row disappears from mempool, "confirmed in last 60s" counter increments.

