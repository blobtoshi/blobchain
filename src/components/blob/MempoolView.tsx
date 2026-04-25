// @ts-nocheck
// Mempool.space-style detailed mempool visualization.
// Mounted only when the Mempool tab is active so its 1s ticker doesn't
// re-render the rest of the explorer.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, Layers, BarChart3, Boxes, Zap, Clock, ArrowDown, ArrowUp,
  ChevronLeft, ChevronRight, Gauge, TrendingUp, Hourglass, Coins,
} from "lucide-react";
import {
  ExplorerTx, mempoolToTxs, shortHash, timeAgo,
  TxFilters, applyTxFilters,
  estimateMempoolTxBytes, feeRateOf, bucketForRate, allBuckets,
  summarizeBlockFees, feeEstimates,
} from "@/lib/blob/explorer";
import {
  MAX_BLOCK_SIZE, BLOCK_TIME, HALVING_BLOCKS, MAX_SUPPLY, MIN_FEE_RATE,
} from "@/lib/blob/constants";
import { useMempoolHistory } from "@/hooks/useMempoolHistory";

type Props = {
  mempool: any[];
  chain: any[];
  blockInfo: any;
  memF: TxFilters;
  setMemF: (f: TxFilters) => void;
  pMem: number;
  setPMem: (n: number) => void;
  onSelectTx: (id: string) => void;
  onSelectBlock?: (height: number) => void;
};

const fmtBytes = (b: number) =>
  b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(2)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;
const fmtEta = (blocks: number) => {
  const mins = Math.round((blocks * BLOCK_TIME) / 60);
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `~${h}h ${m}m` : `~${h}h`;
};

// ───────── Inline SVG sparkline (area) ─────────
function Sparkline({
  data, color, height = 36, fill = true,
}: { data: number[]; color: string; height?: number; fill?: boolean }) {
  if (data.length < 2) {
    return <div className="text-[10px] text-muted-foreground/60 italic">collecting…</div>;
  }
  const w = 100;
  const max = Math.max(1, ...data);
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${height - (v / max) * (height - 2) - 1}`);
  const path = `M${pts.join(" L")}`;
  const area = `${path} L${w},${height} L0,${height} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      {fill && <path d={area} fill={color} opacity={0.18} />}
      <path d={path} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Two overlaid lines for tx/s incoming vs confirmed.
function DualSparkline({
  a, b, colorA, colorB, height = 36,
}: { a: number[]; b: number[]; colorA: string; colorB: string; height?: number }) {
  if (a.length < 2 && b.length < 2) {
    return <div className="text-[10px] text-muted-foreground/60 italic">collecting…</div>;
  }
  const w = 100;
  const max = Math.max(1, ...a, ...b);
  const toPath = (d: number[]) =>
    `M${d.map((v, i) => `${(i / (Math.max(1, d.length - 1))) * w},${height - (v / max) * (height - 2) - 1}`).join(" L")}`;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
      <path d={toPath(a)} fill="none" stroke={colorA} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      <path d={toPath(b)} fill="none" stroke={colorB} strokeWidth={1.4} vectorEffect="non-scaling-stroke" opacity={0.85} />
    </svg>
  );
}

// ───────── Block timeline tile (past / current / projected) ─────────
function BlockTile({
  kind, height, ageLabel, txCount, sizeBytes, fillPct, feeLow, feeMed, feeHigh,
  rewardOrFees, miner, bucketBg, bucketRing, bucketText, active, onClick, subline,
}: any) {
  const stripeH = Math.max(4, Math.min(100, fillPct));
  const ringTone =
    kind === "current" ? "ring-2 ring-[hsl(var(--warning))] animate-pulse"
    : active ? `ring-1 ${bucketRing}`
    : "ring-1 ring-border/40";
  return (
    <button
      onClick={onClick}
      className={`relative shrink-0 w-[148px] glass p-2.5 text-left snap-start transition hover:-translate-y-0.5 hover:ring-1 ${bucketRing} ${ringTone}`}
    >
      {/* fill stripe (vsize %) on left edge */}
      <div className="absolute left-0 top-0 bottom-0 w-1 rounded-l-md overflow-hidden bg-foreground/10">
        <div className={`absolute bottom-0 left-0 right-0 ${bucketBg}`} style={{ height: `${stripeH}%` }} />
      </div>
      <div className="pl-2 space-y-1">
        <div className="flex items-center justify-between">
          <span className={`num text-[11px] font-semibold ${kind === "past" ? "text-[hsl(var(--warning))]" : bucketText}`}>#{height}</span>
          <span className="text-[9px] text-muted-foreground">{ageLabel}</span>
        </div>
        {subline && <div className="text-[9px] text-muted-foreground truncate">{subline}</div>}
        <div className="flex items-baseline justify-between">
          <span className="num text-[10px] text-foreground/80">{txCount} tx</span>
          <span className="num text-[9px] text-muted-foreground">{fmtBytes(sizeBytes)}</span>
        </div>
        <div className="flex items-center gap-1 text-[9px]">
          <span className={`num ${bucketText}`}>{feeLow}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className={`num ${bucketText}`}>{feeMed}</span>
          <span className="text-muted-foreground/60">·</span>
          <span className={`num ${bucketText}`}>{feeHigh}</span>
          <span className="text-[8px] text-muted-foreground/70">d/B</span>
        </div>
        {rewardOrFees && (
          <div className="num text-[9px] text-[hsl(var(--warning))] truncate">{rewardOrFees}</div>
        )}
        {miner && (
          <div className="text-[9px] text-foreground/70 truncate">⛏ {miner}</div>
        )}
      </div>
    </button>
  );
}

export default function MempoolView({
  mempool, chain, blockInfo, memF, setMemF, pMem, setPMem, onSelectTx, onSelectBlock,
}: Props) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Track in/out flow over the last 60s.
  const seenRef = useRef<Map<string, number>>(new Map());
  const confirmedRef = useRef<Map<string, number>>(new Map());
  const prevMemIdsRef = useRef<Set<string>>(new Set());

  // Enrich mempool with vbytes + feeRate.
  const txs = useMemo(() => {
    return (mempool || []).map((t: any) => {
      const bytes = estimateMempoolTxBytes(t);
      const rate = feeRateOf(t, bytes);
      const bucket = bucketForRate(rate);
      return { tx: t, bytes, rate, bucket };
    });
  }, [mempool]);

  useEffect(() => {
    const now = Date.now();
    const currentIds = new Set(mempool.map((t: any) => t.id));
    for (const id of currentIds) {
      if (!seenRef.current.has(id)) seenRef.current.set(id, now);
    }
    for (const id of prevMemIdsRef.current) {
      if (!currentIds.has(id)) confirmedRef.current.set(id, now);
    }
    prevMemIdsRef.current = currentIds;
    for (const [id, ts] of seenRef.current) if (now - ts > 120_000) seenRef.current.delete(id);
    for (const [id, ts] of confirmedRef.current) if (now - ts > 120_000) confirmedRef.current.delete(id);
  }, [mempool]);

  const now = Date.now();
  const incoming60 = Array.from(seenRef.current.values()).filter(ts => now - ts < 60_000).length;
  const confirmed60 = Array.from(confirmedRef.current.values()).filter(ts => now - ts < 60_000).length;

  // Aggregates.
  const totalBytes = txs.reduce((s, x) => s + x.bytes, 0);
  const totalFees = txs.reduce((s, x) => s + Number(x.tx.fee || 0), 0);
  const avgRate = txs.length ? Math.round(txs.reduce((s, x) => s + x.rate, 0) / txs.length) : 0;
  const load = Math.min(1, totalBytes / MAX_BLOCK_SIZE);
  const loadPct = Math.round(load * 100);
  let loadLabel = "Idle", loadTone = "text-[hsl(var(--info))]", loadBar = "bg-[hsl(var(--info))]";
  if (load >= 0.66) { loadLabel = "Congested"; loadTone = "text-[hsl(var(--danger))]"; loadBar = "bg-[hsl(var(--danger))]"; }
  else if (load >= 0.25) { loadLabel = "Busy"; loadTone = "text-[hsl(var(--warning))]"; loadBar = "bg-[hsl(var(--warning))]"; }
  else if (load > 0) { loadLabel = "Light"; loadTone = "text-primary"; loadBar = "bg-primary"; }

  // Projected blocks: greedy fee-rate descending packing — up to 8 for the timeline.
  const projected = useMemo(() => {
    const sorted = [...txs].sort((a, b) => b.rate - a.rate);
    const blocks: { txs: typeof txs; bytes: number; fees: number; rates: number[] }[] = [];
    let cur = { txs: [] as any[], bytes: 0, fees: 0, rates: [] as number[] };
    for (const x of sorted) {
      if (cur.bytes + x.bytes > MAX_BLOCK_SIZE && cur.txs.length > 0) {
        blocks.push(cur); cur = { txs: [], bytes: 0, fees: 0, rates: [] };
        if (blocks.length >= 8) break;
      }
      cur.txs.push(x); cur.bytes += x.bytes; cur.fees += Number(x.tx.fee || 0); cur.rates.push(x.rate);
    }
    if (cur.txs.length && blocks.length < 8) blocks.push(cur);
    return blocks;
  }, [txs]);

  // Fee histogram by bucket.
  const histogram = useMemo(() => {
    const counts = allBuckets().map(b => ({ bucket: b, count: 0, bytes: 0 }));
    for (const x of txs) { counts[x.bucket.idx].count++; counts[x.bucket.idx].bytes += x.bytes; }
    return counts;
  }, [txs]);
  const maxCount = Math.max(1, ...histogram.map(h => h.count));

  // Fee estimation tiers.
  const ests = useMemo(
    () => feeEstimates(txs.map(x => ({ rate: x.rate, bytes: x.bytes })), MAX_BLOCK_SIZE, MIN_FEE_RATE),
    [txs],
  );

  // History sparklines.
  const history = useMempoolHistory(mempool, estimateMempoolTxBytes, 60);
  const histCount = history.map(h => h.count);
  const histVbytes = history.map(h => h.vbytes);
  const histFees = history.map(h => h.fees);
  const histIn = history.map(h => h.incoming);
  const histConf = history.map(h => h.confirmed);

  // Filtered tx stream.
  const memTxs = useMemo(() => mempoolToTxs(mempool || []), [mempool]);
  const memFiltered = useMemo(() => applyTxFilters(memTxs, memF), [memTxs, memF]);
  const PAGE = 50;

  const [bucketFilter, setBucketFilter] = useState<number | null>(null);
  const streamTxs = useMemo(() => {
    let out = memFiltered;
    if (bucketFilter != null) {
      const ids = new Set(txs.filter(x => x.bucket.idx === bucketFilter).map(x => x.tx.id));
      out = out.filter(t => ids.has(t.id));
    }
    return out.slice().sort((a, b) => {
      const ra = txs.find(x => x.tx.id === a.id)?.rate ?? 0;
      const rb = txs.find(x => x.tx.id === b.id)?.rate ?? 0;
      return rb - ra;
    });
  }, [memFiltered, bucketFilter, txs]);

  // Map tx id → which projected block it lands in.
  const projBlockOf = useMemo(() => {
    const m = new Map<string, number>();
    projected.forEach((b, i) => b.txs.forEach((x: any) => m.set(x.tx.id, i + 1)));
    return m;
  }, [projected]);

  // Past blocks (last 8, newest-first for layout).
  const pastBlocks = useMemo(() => {
    return [...chain].slice(-8).reverse();
  }, [chain]);

  // Halving / supply.
  const tipHeight = chain.length ? chain[chain.length - 1].height : 0;
  const intoEpoch = tipHeight % HALVING_BLOCKS;
  const blocksToHalving = HALVING_BLOCKS - intoEpoch;
  const epochPct = Math.round((intoEpoch / HALVING_BLOCKS) * 100);
  const totalSupply = chain.reduce((s: number, b: any) => s + Number(b.reward || 0), 0);
  const supplyPct = Math.min(100, (totalSupply / MAX_SUPPLY) * 100);

  // Timeline scroll.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const scrollBy = (dx: number) => scrollerRef.current?.scrollBy({ left: dx, behavior: "smooth" });

  return (
    <div className="space-y-3">
      {/* ───────── Block timeline ───────── */}
      <div className="glass-hi p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="label-eyebrow flex items-center gap-1.5 !mb-0">
            <Boxes className="w-3 h-3" /> Blockchain timeline
          </span>
          <div className="flex items-center gap-1">
            <button onClick={() => scrollBy(-300)} className="p-1 hover:bg-secondary/40 transition rounded">
              <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button onClick={() => scrollBy(300)} className="p-1 hover:bg-secondary/40 transition rounded">
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        <div
          ref={scrollerRef}
          className="flex gap-2 overflow-x-auto snap-x scroll-smooth pb-2 -mx-1 px-1"
          style={{ scrollbarWidth: "thin" }}
        >
          {/* Projected blocks (right of current) — show in reverse so cheapest furthest right */}
          {projected.length === 0 && (
            <div className="shrink-0 w-[148px] glass p-2.5 border-dashed border border-border/40 flex items-center justify-center text-[10px] text-muted-foreground/60 snap-start">
              no projected blocks
            </div>
          )}
          {projected.slice().reverse().map((b, ri) => {
            const i = projected.length - 1 - ri;
            const median = b.rates[Math.floor(b.rates.length / 2)] ?? 0;
            const minR = Math.min(...b.rates);
            const maxR = Math.max(...b.rates);
            const bucket = bucketForRate(median);
            const fillPct = Math.round((b.bytes / MAX_BLOCK_SIZE) * 100);
            const active = bucketFilter === bucket.idx;
            return (
              <BlockTile
                key={`proj-${i}`}
                kind="projected"
                height={blockInfo.height + i}
                ageLabel={`in ${fmtEta(i + 1)}`}
                subline={`projected · ~${median} d/B`}
                txCount={b.txs.length}
                sizeBytes={b.bytes}
                fillPct={fillPct}
                feeLow={minR} feeMed={median} feeHigh={maxR}
                rewardOrFees={`+${b.fees.toFixed(4)} BLOB fees`}
                bucketBg={bucket.bg} bucketRing={bucket.ring} bucketText={bucket.text}
                active={active}
                onClick={() => setBucketFilter(active ? null : bucket.idx)}
              />
            );
          })}

          {/* Current sealing block */}
          <BlockTile
            kind="current"
            height={blockInfo.height}
            ageLabel={blockInfo.awaitingMiner ? "awaiting" : `${blockInfo.remaining}s left`}
            subline="sealing now"
            txCount={txs.length}
            sizeBytes={totalBytes}
            fillPct={loadPct}
            feeLow={txs.length ? Math.min(...txs.map(x => x.rate)) : 0}
            feeMed={avgRate}
            feeHigh={txs.length ? Math.max(...txs.map(x => x.rate)) : 0}
            rewardOrFees={`reward ${blockInfo.reward} BLOB`}
            bucketBg="bg-[hsl(var(--warning))]"
            bucketRing="ring-[hsl(var(--warning))]"
            bucketText="text-[hsl(var(--warning))]"
            onClick={() => {}}
          />

          {/* Past confirmed blocks */}
          {pastBlocks.map((b: any, depth: number) => {
            const s = summarizeBlockFees(b);
            const bucket = bucketForRate(s.medRate);
            const fillPct = Math.round((s.sizeBytes / MAX_BLOCK_SIZE) * 100);
            const opacity = Math.max(0.55, 1 - depth * 0.05);
            return (
              <div key={`past-${b.height}`} style={{ opacity }}>
                <BlockTile
                  kind="past"
                  height={b.height}
                  ageLabel={timeAgo(b.timestamp)}
                  subline={`#${b.height} · ${s.txCount ? "confirmed" : "empty"}`}
                  txCount={s.txCount}
                  sizeBytes={s.sizeBytes}
                  fillPct={Math.max(2, fillPct)}
                  feeLow={s.minRate} feeMed={s.medRate} feeHigh={s.maxRate}
                  rewardOrFees={`reward ${Number(b.reward || 0)} BLOB${s.totalFees ? ` · +${s.totalFees.toFixed(4)} fees` : ""}`}
                  miner={(b.winner ? shortHash(b.winner, 4) : "—")}
                  bucketBg={bucket.bg} bucketRing={bucket.ring} bucketText={bucket.text}
                  onClick={() => onSelectBlock?.(b.height)}
                />
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center justify-between text-[9px] text-muted-foreground pt-1 border-t border-border/40">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-[hsl(var(--warning))] rounded-sm" /> sealing</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-primary/70 rounded-sm" /> projected</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 bg-foreground/40 rounded-sm" /> confirmed</span>
          </div>
          <span>← click confirmed blocks for details</span>
        </div>
      </div>

      {/* ───────── Fee estimation panel ───────── */}
      <div className="glass-hi p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="label-eyebrow flex items-center gap-1.5 !mb-0">
            <Gauge className="w-3 h-3" /> Fee estimates · drops per byte
          </span>
          <span className="text-[10px] text-muted-foreground">live · {BLOCK_TIME}s blocks</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {[
            { k: "noPriority", label: "No prio", tone: "text-muted-foreground", e: ests.noPriority },
            { k: "low", label: "Low", tone: "text-[hsl(var(--info))]", e: ests.low },
            { k: "medium", label: "Medium", tone: "text-primary", e: ests.medium },
            { k: "high", label: "High", tone: "text-[hsl(var(--warning))]", e: ests.high },
            { k: "priority", label: "Priority", tone: "text-[hsl(var(--danger))]", e: ests.priority },
          ].map(t => (
            <div key={t.k} className="glass p-2 text-center">
              <div className="label-eyebrow !mb-0.5 text-[9px]">{t.label}</div>
              <div className={`num text-sm font-semibold ${t.tone}`}>{t.e.rate}</div>
              <div className="text-[9px] text-muted-foreground">{fmtEta(t.e.etaBlocks)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ───────── Header strip ───────── */}
      <div className="glass-hi p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span className="label-eyebrow !mb-0">Live mempool</span>
          </div>
          <div className={`text-[11px] font-semibold uppercase tracking-wider ${loadTone}`}>{loadLabel} · {loadPct}%</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="label-eyebrow">Pending</div>
            <div className="num text-lg font-semibold text-primary">{txs.length}</div>
            <div className="text-[10px] text-muted-foreground">unconfirmed tx</div>
          </div>
          <div>
            <div className="label-eyebrow">Vsize</div>
            <div className="num text-lg font-semibold">{fmtBytes(totalBytes)}</div>
            <div className="text-[10px] text-muted-foreground">/ {fmtBytes(MAX_BLOCK_SIZE)}</div>
          </div>
          <div>
            <div className="label-eyebrow">Total fees</div>
            <div className="num text-lg font-semibold text-[hsl(var(--warning))]">{totalFees.toFixed(4)}</div>
            <div className="text-[10px] text-muted-foreground">BLOB queued</div>
          </div>
        </div>
        <div className="h-1.5 w-full bg-foreground/10 rounded-full overflow-hidden">
          <div className={`h-full ${loadBar} transition-all duration-700`} style={{ width: `${loadPct}%` }} />
        </div>
      </div>

      {/* ───────── Flow + sparklines ───────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="glass p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="label-eyebrow !mb-0 flex items-center gap-1"><TrendingUp className="w-3 h-3" /> Mempool size</span>
            <span className="num text-[10px] text-muted-foreground">{histCount[histCount.length - 1] ?? txs.length} tx</span>
          </div>
          <Sparkline data={histCount} color="hsl(var(--primary))" />
          <div className="text-[9px] text-muted-foreground">last 60s · count</div>
        </div>
        <div className="glass p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="label-eyebrow !mb-0 flex items-center gap-1"><Activity className="w-3 h-3" /> TX flow</span>
            <span className="num text-[10px] text-muted-foreground">
              <ArrowDown className="w-2.5 h-2.5 inline text-primary" />{incoming60}
              <span className="mx-1">·</span>
              <ArrowUp className="w-2.5 h-2.5 inline text-[hsl(var(--info))]" />{confirmed60}
            </span>
          </div>
          <DualSparkline a={histIn} b={histConf} colorA="hsl(var(--primary))" colorB="hsl(var(--info))" />
          <div className="text-[9px] text-muted-foreground">incoming vs confirmed / s</div>
        </div>
        <div className="glass p-3 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="label-eyebrow !mb-0 flex items-center gap-1"><Zap className="w-3 h-3" /> Fees queued</span>
            <span className="num text-[10px] text-[hsl(var(--warning))]">{totalFees.toFixed(4)}</span>
          </div>
          <Sparkline data={histFees} color="hsl(var(--warning))" />
          <div className="text-[9px] text-muted-foreground">last 60s · BLOB</div>
        </div>
      </div>

      {/* ───────── Difficulty / epoch / supply ───────── */}
      <div className="glass p-3 space-y-2">
        <div className="flex items-center justify-between">
          <span className="label-eyebrow !mb-0 flex items-center gap-1.5"><Hourglass className="w-3 h-3" /> Halving epoch</span>
          <span className="num text-[10px] text-muted-foreground">tip #{tipHeight}</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[9px] text-muted-foreground">Reward</div>
            <div className="num text-sm font-semibold text-[hsl(var(--warning))]">{blockInfo.reward} BLOB</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground">Until next halving</div>
            <div className="num text-sm font-semibold">{blocksToHalving.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-[9px] text-muted-foreground flex items-center gap-1"><Coins className="w-2.5 h-2.5" />Supply minted</div>
            <div className="num text-sm font-semibold text-primary">{supplyPct.toFixed(3)}%</div>
          </div>
        </div>
        <div>
          <div className="h-1.5 w-full bg-foreground/10 rounded-full overflow-hidden">
            <div className="h-full bg-[hsl(var(--warning))] transition-all" style={{ width: `${epochPct}%` }} />
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground mt-1 num">
            <span>{intoEpoch.toLocaleString()} into epoch</span>
            <span>{HALVING_BLOCKS.toLocaleString()} blocks/epoch</span>
          </div>
        </div>
      </div>

      {/* ───────── Empty mempool fallback for the rest ───────── */}
      {(!mempool || mempool.length === 0) ? (
        <div className="glass p-6 text-center space-y-2">
          <div className="flex justify-center"><Layers className="w-8 h-8 text-primary/60" /></div>
          <div className="text-sm font-medium text-foreground/80">Mempool is clear</div>
          <div className="text-xs text-muted-foreground">No pending transactions queued for block #{blockInfo.height}.</div>
        </div>
      ) : (
        <>
          {/* Fee histogram */}
          <div className="glass p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="label-eyebrow flex items-center gap-1.5"><BarChart3 className="w-3 h-3" /> Fee distribution</span>
              {bucketFilter != null && (
                <button onClick={() => setBucketFilter(null)} className="text-[10px] text-muted-foreground hover:text-foreground">clear filter</button>
              )}
            </div>
            <div className="flex items-end justify-between gap-1.5 h-24">
              {histogram.map(h => {
                const pct = (h.count / maxCount) * 100;
                const active = bucketFilter === h.bucket.idx;
                return (
                  <button key={h.bucket.idx}
                    onClick={() => setBucketFilter(active ? null : h.bucket.idx)}
                    title={`${h.bucket.label} drops/B · ${h.count} tx · ${fmtBytes(h.bytes)}`}
                    className="flex-1 flex flex-col items-center gap-1 group"
                  >
                    <span className={`num text-[10px] ${active ? h.bucket.text : "text-muted-foreground"}`}>{h.count || ""}</span>
                    <div className="w-full h-full flex items-end">
                      <div
                        className={`w-full rounded-sm transition-all ${h.bucket.bg} ${active ? "opacity-100 ring-1 " + h.bucket.ring : "opacity-80 group-hover:opacity-100"}`}
                        style={{ height: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-between gap-1.5 mt-1.5">
              {histogram.map(h => (
                <span key={h.bucket.idx} className="flex-1 text-center num text-[9px] text-muted-foreground">{h.bucket.label}</span>
              ))}
            </div>
            <div className="text-[10px] text-muted-foreground text-center mt-1">drops per byte</div>
          </div>

          {/* Mempool goggles */}
          <div className="glass p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="label-eyebrow flex items-center gap-1.5"><Activity className="w-3 h-3" /> Mempool goggles</span>
              <span className="text-[10px] text-muted-foreground num">{txs.length} cells</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {txs.slice().sort((a, b) => b.rate - a.rate).map(x => {
                const w = Math.max(10, Math.min(64, Math.round(x.bytes / 12)));
                return (
                  <button
                    key={x.tx.id}
                    onClick={() => onSelectTx(x.tx.id)}
                    title={`${shortHash(x.tx.id, 6)} · ${x.rate} d/B · ${x.tx.amount} BLOB · ${fmtBytes(x.bytes)} · in block +${projBlockOf.get(x.tx.id) ?? "?"}`}
                    className={`h-7 ${x.bucket.bg} hover:ring-2 ${x.bucket.ring} transition rounded-sm`}
                    style={{ width: `${w}px` }}
                  />
                );
              })}
            </div>
          </div>

          {/* Live tx stream */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between px-1">
              <span className="label-eyebrow flex items-center gap-1.5"><Clock className="w-3 h-3" /> Live transactions</span>
              <span className="text-[10px] text-muted-foreground num">
                {streamTxs.length}{streamTxs.length !== memTxs.length && ` of ${memTxs.length}`} pending
              </span>
            </div>
            <div className="grid grid-cols-[52px_1fr_56px_44px_44px_36px] sm:grid-cols-[70px_1fr_80px_60px_60px_50px] gap-2 px-3 py-1">
              {["Fee/B", "From → To", "Amount", "Vsize", "ETA", "Age"].map(h => <div key={h} className="label-eyebrow">{h}</div>)}
            </div>
            {streamTxs.slice(pMem * PAGE, (pMem + 1) * PAGE).map(t => {
              const meta = txs.find(x => x.tx.id === t.id);
              const rate = meta?.rate ?? 0;
              const bytes = meta?.bytes ?? 0;
              const bucket = meta?.bucket ?? bucketForRate(rate);
              const eta = projBlockOf.get(t.id);
              return (
                <button key={t.id} onClick={() => onSelectTx(t.id)}
                  className={`w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition border-l-2 ${bucket.ring.replace("ring-", "border-l-")} grid grid-cols-[52px_1fr_56px_44px_44px_36px] sm:grid-cols-[70px_1fr_80px_60px_60px_50px] gap-2 items-center text-xs`}
                >
                  <span className={`num font-semibold ${bucket.text}`}>{rate} <span className="text-[9px] font-normal text-muted-foreground">d/B</span></span>
                  <span className="text-foreground/80 truncate">{t.from === "coinbase" ? "blob" : shortHash(t.from, 6)} → {shortHash(t.to, 6)}</span>
                  <span className="num text-primary/90">{t.amount}</span>
                  <span className="num text-muted-foreground">{bytes}B</span>
                  <span className="num text-[10px] text-foreground/70">{eta ? `+${eta}` : "—"}</span>
                  <span className="num text-right text-[hsl(var(--warning))] text-[10px]">{timeAgo(t.timestamp)}</span>
                </button>
              );
            })}
            {streamTxs.length > PAGE && (
              <div className="glass flex items-center justify-between px-3 py-2 text-xs">
                <span className="text-muted-foreground num">{pMem * PAGE + 1}–{Math.min((pMem + 1) * PAGE, streamTxs.length)} of {streamTxs.length}</span>
                <div className="flex items-center gap-1">
                  <button disabled={pMem === 0} onClick={() => setPMem(Math.max(0, pMem - 1))}
                    className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 transition">‹</button>
                  <button disabled={(pMem + 1) * PAGE >= streamTxs.length} onClick={() => setPMem(pMem + 1)}
                    className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 transition">›</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
