// @ts-nocheck
// Mempool.space-style detailed mempool visualization.
// Mounted only when the Mempool tab is active so its 1s ticker doesn't
// re-render the rest of the explorer.
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Layers, BarChart3, Boxes, Zap, Clock, ArrowDown, ArrowUp } from "lucide-react";
import {
  ExplorerTx, mempoolToTxs, shortHash, timeAgo,
  TxFilters, emptyTxFilters, applyTxFilters, txFiltersActive,
  estimateMempoolTxBytes, feeRateOf, bucketForRate, allBuckets,
} from "@/lib/blob/explorer";
import { MAX_BLOCK_SIZE, BLOCK_TIME, FEE_BUCKETS } from "@/lib/blob/constants";

type Props = {
  mempool: any[];
  chain: any[];
  blockInfo: any;
  memF: TxFilters;
  setMemF: (f: TxFilters) => void;
  pMem: number;
  setPMem: (n: number) => void;
  onSelectTx: (id: string) => void;
};

const fmtBytes = (b: number) => b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(2)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`;

export default function MempoolView({ mempool, chain, blockInfo, memF, setMemF, pMem, setPMem, onSelectTx }: Props) {
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

  // Track newly seen tx ids and recently confirmed ids.
  useEffect(() => {
    const now = Date.now();
    const currentIds = new Set(mempool.map((t: any) => t.id));
    for (const id of currentIds) {
      if (!seenRef.current.has(id)) seenRef.current.set(id, now);
    }
    // Anything that *was* in mempool but isn't now → likely confirmed.
    for (const id of prevMemIdsRef.current) {
      if (!currentIds.has(id)) confirmedRef.current.set(id, now);
    }
    prevMemIdsRef.current = currentIds;
    // GC old entries (>120s).
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

  // Projected blocks: greedy fee-rate descending packing into MAX_BLOCK_SIZE buckets, up to 3.
  const projected = useMemo(() => {
    const sorted = [...txs].sort((a, b) => b.rate - a.rate);
    const blocks: { txs: typeof txs; bytes: number; fees: number }[] = [];
    let cur = { txs: [] as any[], bytes: 0, fees: 0 };
    for (const x of sorted) {
      if (cur.bytes + x.bytes > MAX_BLOCK_SIZE && cur.txs.length > 0) {
        blocks.push(cur); cur = { txs: [], bytes: 0, fees: 0 };
        if (blocks.length >= 3) break;
      }
      cur.txs.push(x); cur.bytes += x.bytes; cur.fees += Number(x.tx.fee || 0);
    }
    if (cur.txs.length && blocks.length < 3) blocks.push(cur);
    return blocks;
  }, [txs]);

  // Fee histogram by bucket.
  const histogram = useMemo(() => {
    const counts = allBuckets().map(b => ({ bucket: b, count: 0, bytes: 0 }));
    for (const x of txs) counts[x.bucket.idx].count++, counts[x.bucket.idx].bytes += x.bytes;
    return counts;
  }, [txs]);
  const maxCount = Math.max(1, ...histogram.map(h => h.count));

  // Filtered tx stream.
  const memTxs = useMemo(() => mempoolToTxs(mempool || []), [mempool]);
  const memFiltered = useMemo(() => applyTxFilters(memTxs, memF), [memTxs, memF]);
  const PAGE = 50;

  // Bucket filter (click on histogram or projected block).
  const [bucketFilter, setBucketFilter] = useState<number | null>(null);
  const streamTxs = useMemo(() => {
    let out = memFiltered;
    if (bucketFilter != null) {
      const ids = new Set(txs.filter(x => x.bucket.idx === bucketFilter).map(x => x.tx.id));
      out = out.filter(t => ids.has(t.id));
    }
    // Sort by feeRate desc by default.
    return out.slice().sort((a, b) => {
      const ra = txs.find(x => x.tx.id === a.id)?.rate ?? 0;
      const rb = txs.find(x => x.tx.id === b.id)?.rate ?? 0;
      return rb - ra;
    });
  }, [memFiltered, bucketFilter, txs]);

  if (!mempool || mempool.length === 0) {
    return (
      <div className="space-y-3">
        <div className="glass-hi p-6 text-center space-y-2">
          <div className="flex justify-center"><Layers className="w-8 h-8 text-primary/60" /></div>
          <div className="text-sm font-medium text-foreground/80">Mempool is clear</div>
          <div className="text-xs text-muted-foreground">Next block (#{blockInfo.height}) has no pending transactions queued.</div>
        </div>
        <div className="grid grid-cols-3 gap-2 opacity-40 pointer-events-none select-none">
          {[1, 2, 3].map(i => (
            <div key={i} className="glass p-3 h-28 flex items-center justify-center text-[10px] text-muted-foreground">
              empty block
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header strip */}
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

      {/* Flow strip */}
      <div className="glass p-3 grid grid-cols-3 gap-3 text-xs">
        <div className="flex items-center gap-2">
          <ArrowDown className="w-3.5 h-3.5 text-primary" />
          <div>
            <div className="num font-semibold">{incoming60}</div>
            <div className="text-[10px] text-muted-foreground">in / 60s</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ArrowUp className="w-3.5 h-3.5 text-[hsl(var(--info))]" />
          <div>
            <div className="num font-semibold">{confirmed60}</div>
            <div className="text-[10px] text-muted-foreground">confirmed / 60s</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-[hsl(var(--warning))]" />
          <div>
            <div className="num font-semibold">{avgRate}</div>
            <div className="text-[10px] text-muted-foreground">avg drops/B</div>
          </div>
        </div>
      </div>

      {/* Projected blocks */}
      <div>
        <div className="flex items-center justify-between px-1 mb-2">
          <span className="label-eyebrow flex items-center gap-1.5"><Boxes className="w-3 h-3" /> Projected blocks</span>
          <span className="text-[10px] text-muted-foreground">{BLOCK_TIME}s target</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map(i => {
            const b = projected[i];
            if (!b) {
              return (
                <div key={i} className="glass p-3 h-28 flex flex-col items-center justify-center text-[10px] text-muted-foreground/60 border-dashed border border-border/40">
                  empty
                </div>
              );
            }
            const median = b.txs[Math.floor(b.txs.length / 2)]?.rate ?? 0;
            const bucket = bucketForRate(median);
            const fillPct = Math.round((b.bytes / MAX_BLOCK_SIZE) * 100);
            return (
              <button key={i}
                onClick={() => setBucketFilter(bucketFilter === bucket.idx ? null : bucket.idx)}
                className={`glass p-3 text-left transition hover:ring-1 ${bucket.ring} ${bucketFilter === bucket.idx ? `ring-1 ${bucket.ring}` : ""}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className={`num text-sm font-semibold ${bucket.text}`}>~{median} <span className="text-[10px] text-muted-foreground font-normal">d/B</span></span>
                  <span className="text-[10px] text-muted-foreground">#{blockInfo.height + i}</span>
                </div>
                <div className="num text-[11px] text-foreground/80">{b.txs.length} tx</div>
                <div className="num text-[10px] text-muted-foreground">{fmtBytes(b.bytes)}</div>
                <div className="num text-[10px] text-[hsl(var(--warning))] mt-0.5">+{b.fees.toFixed(4)} BLOB</div>
                <div className="h-1 w-full bg-foreground/10 rounded-full overflow-hidden mt-2">
                  <div className={`h-full ${bucket.bg}`} style={{ width: `${fillPct}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      </div>

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
                title={`${shortHash(x.tx.id, 6)} · ${x.rate} d/B · ${x.tx.amount} BLOB · ${fmtBytes(x.bytes)}`}
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
        <div className="grid grid-cols-[60px_1fr_60px_60px_50px] sm:grid-cols-[80px_1fr_80px_80px_70px] gap-2 px-3 py-1">
          {["Fee/B", "From → To", "Amount", "Vsize", "Age"].map(h => <div key={h} className="label-eyebrow">{h}</div>)}
        </div>
        {streamTxs.slice(pMem * PAGE, (pMem + 1) * PAGE).map(t => {
          const meta = txs.find(x => x.tx.id === t.id);
          const rate = meta?.rate ?? 0;
          const bytes = meta?.bytes ?? 0;
          const bucket = meta?.bucket ?? bucketForRate(rate);
          return (
            <button key={t.id} onClick={() => onSelectTx(t.id)}
              className={`w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition border-l-2 ${bucket.ring.replace("ring-", "border-l-")} grid grid-cols-[60px_1fr_60px_60px_50px] sm:grid-cols-[80px_1fr_80px_80px_70px] gap-2 items-center text-xs`}
            >
              <span className={`num font-semibold ${bucket.text}`}>{rate} <span className="text-[9px] font-normal text-muted-foreground">d/B</span></span>
              <span className="text-foreground/80 truncate">{t.fromUsername || shortHash(t.from, 6)} → {shortHash(t.to, 6)}</span>
              <span className="num text-primary/90">{t.amount}</span>
              <span className="num text-muted-foreground">{bytes}B</span>
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
    </div>
  );
}
