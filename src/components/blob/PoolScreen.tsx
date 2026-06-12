// P2P WBLOB ↔ USDC Pool — Solana-native two-sided CLOB.
//
// Buyer/Seller are symmetric: both escrow principal + 1% fee in their native
// asset (USDC for buy orders, WBLOB for sell orders). Backend matches the
// order against the opposite book on placement; partial fills leave the
// remainder resting. Cancel refunds remaining principal + remaining fee.
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as Pool from "@/lib/poolRelay";
import {
  ArrowDownUp, Loader2, CheckCircle2, AlertCircle, ExternalLink, X, ChevronDown,
  Maximize2, Minimize2,
} from "lucide-react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import wblobLogo from "@/assets/blob-coin.png";
import usdcLogo from "@/assets/usdc-logo.png";

const SolanaProvider = lazy(() => import("./SolanaProvider"));
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const USDC_DECIMALS = 6;
const WBLOB_DECIMALS_FALLBACK = 9;
const PX_DP = 6;
const QTY_DP = 4;
const FEE_RATE = 0.01; // 1% per side (matches POOL_FEE_BPS=100 default on backend)

const T = {
  bg: "#0B0E13", panel: "#11151C", panelHi: "#161B25",
  border: "#1F2733", borderHi: "#2A3442",
  text: "#E6EAF2", textDim: "#8A93A6", textMute: "#5C657A",
  green: "#16C784", greenSoft: "rgba(22,199,132,0.12)",
  red: "#EA3943", redSoft: "rgba(234,57,67,0.12)",
  accent: "#7B9CFF",
};
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontVariantNumeric: "tabular-nums" as const };

export default function PoolScreen({ wallet }: any) {
  const [book, setBook] = useState<Pool.PoolBook | null>(null);
  const [candles, setCandles] = useState<Pool.Candle[]>([]);
  const [expanded, setExpanded] = useState(false);

  const refresh = async () => {
    const { publicKey } = (window as any)._solWallet ?? {};
    const owner = publicKey?.toBase58?.() ?? undefined;
    const [b, c] = await Promise.all([Pool.fetchPoolBook(owner), Pool.fetchPoolCandles()]);
    if (b) setBook(b);
    setCandles(c);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastPrice = book?.stats.last_price ?? null;
  const change24 = useMemo(() => {
    if (!candles.length || !lastPrice) return null;
    const cutoff = Date.now() - 24 * 3600_000;
    const ref = [...candles].reverse().find((c) => c.t * 1000 <= cutoff) ?? candles[0];
    if (!ref?.o) return null;
    return ((lastPrice - ref.o) / ref.o) * 100;
  }, [candles, lastPrice]);
  const high24 = useMemo(() => {
    if (!candles.length) return null;
    const cutoff = Date.now() / 1000 - 86400;
    const slice = candles.filter((c) => c.t >= cutoff);
    return slice.length ? Math.max(...slice.map((c) => c.h)) : null;
  }, [candles]);
  const low24 = useMemo(() => {
    if (!candles.length) return null;
    const cutoff = Date.now() / 1000 - 86400;
    const slice = candles.filter((c) => c.t >= cutoff);
    return slice.length ? Math.min(...slice.map((c) => c.l)) : null;
  }, [candles]);

  return (
    <div style={{ background: T.bg, color: T.text, borderRadius: 16, border: `1px solid ${T.border}`, overflow: "hidden" }}>
      {/* ───────── Top stat bar ───────── */}
      <div style={{ borderBottom: `1px solid ${T.border}`, background: T.panel }}
        className="flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="relative flex">
            <img src={wblobLogo} alt="WBLOB" className="w-7 h-7 rounded-full object-cover" />
            <img src={usdcLogo} alt="USDC" className="w-7 h-7 rounded-full object-cover" style={{ marginLeft: -10 }} />
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">WBLOB / USDC <ChevronDown className="w-3.5 h-3.5" style={{ color: T.textDim }} /></div>
            <div style={{ color: T.textMute }} className="text-[10px] uppercase tracking-widest">Solana · CLOB</div>
          </div>
        </div>
        <Stat label="Price" value={lastPrice ? `$${lastPrice.toFixed(PX_DP)}` : "—"} accent={T.text} />
        <Stat label="24h Change" value={change24 !== null ? `${change24 >= 0 ? "+" : ""}${change24.toFixed(2)}%` : "—"} accent={change24 == null ? T.text : change24 >= 0 ? T.green : T.red} />
        <Stat label="24h High" value={high24 ? `$${high24.toFixed(PX_DP)}` : "—"} />
        <Stat label="24h Low" value={low24 ? `$${low24.toFixed(PX_DP)}` : "—"} />
        <Stat label="24h Volume" value={book ? `${book.stats.vol_blob.toFixed(2)}` : "—"} suffix="WBLOB" />
        <div className="ml-auto" />
      </div>

      <Suspense fallback={<div className="p-10 flex items-center justify-center text-sm gap-2" style={{ color: T.textDim }}><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>}>
        <SolanaProvider endpoint={null}>
          <SolWalletBridge onChange={refresh} />
          <div
            className={`grid grid-cols-1 ${expanded ? "lg:grid-cols-[1fr_340px]" : "lg:grid-cols-[1fr_280px_340px]"} gap-px`}
            style={{ background: T.border }}
          >
            <div style={{ background: T.bg }} className="min-w-0">
              <PriceChart
                candles={candles}
                lastPrice={lastPrice}
                expanded={expanded}
                onToggleExpand={() => setExpanded((v) => !v)}
              />
              {expanded ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-px" style={{ background: T.border }}>
                  <div style={{ background: T.bg }}>
                    <OrderBook book={book} />
                  </div>
                  <div style={{ background: T.bg }}>
                    <RecentTrades fills={book?.fills ?? []} />
                  </div>
                </div>
              ) : (
                <RecentTrades fills={book?.fills ?? []} />
              )}
            </div>
            {!expanded && (
              <div style={{ background: T.bg }}>
                <OrderBook book={book} />
              </div>
            )}
            <div style={{ background: T.bg }}>
              <TradePanel book={book} onDone={refresh} />
              <MyOrders mine={book?.mine ?? []} onDone={refresh} />
            </div>
          </div>
        </SolanaProvider>
      </Suspense>
    </div>
  );
}

function Stat({ label, value, suffix, accent }: { label: string; value: string; suffix?: string; accent?: string }) {
  return (
    <div>
      <div style={{ color: T.textMute }} className="text-[10px] uppercase tracking-[0.12em]">{label}</div>
      <div style={{ ...mono, color: accent ?? T.text }} className="text-[13px] font-medium leading-tight">
        {value}{suffix && <span style={{ color: T.textMute }} className="ml-1 text-[10px]">{suffix}</span>}
      </div>
    </div>
  );
}

function SolWalletBridge({ onChange }: { onChange: () => void }) {
  const w = useWallet();
  useEffect(() => {
    (window as any)._solWallet = { publicKey: w.publicKey };
    onChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.publicKey?.toBase58()]);
  return null;
}

/* ─────────────────────── Order book ─────────────────────── */
function OrderBook({ book }: { book: Pool.PoolBook | null }) {
  const asks = book?.asks ?? [];
  const bids = book?.bids ?? [];
  const maxRem = useMemo(() => {
    const all = [...asks, ...bids];
    return all.reduce((a, r) => Math.max(a, Number(r.remaining_wblob)), 0) || 1;
  }, [asks, bids]);
  const last = book?.stats.last_price ?? null;

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 pt-3 pb-2">
        <div style={{ color: T.text }} className="text-[11px] font-semibold uppercase tracking-wider">Order Book</div>
      </div>
      <div className="grid grid-cols-3 px-3 pb-1 text-[10px] uppercase tracking-wider" style={{ color: T.textMute }}>
        <div>Price</div>
        <div className="text-right">Size</div>
        <div className="text-right">Total</div>
      </div>
      {/* Asks (high → low so lowest is closest to spread) */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {asks.length === 0 && <div style={{ color: T.textMute }} className="py-3 text-center text-[11px]">No asks</div>}
        {[...asks].slice(0, 12).reverse().map((r) => {
          const w = Math.max(2, Math.round((Number(r.remaining_wblob) / maxRem) * 100));
          const total = Number(r.remaining_wblob) * Number(r.price_usdc);
          return (
            <div key={r.id} className="relative grid grid-cols-3 px-1.5 py-[3px] text-[11px]" style={mono}>
              <span aria-hidden className="absolute inset-y-0 right-0" style={{ width: `${w}%`, background: T.redSoft }} />
              <span className="relative" style={{ color: T.red }}>{Number(r.price_usdc).toFixed(PX_DP)}</span>
              <span className="relative text-right">{Number(r.remaining_wblob).toFixed(QTY_DP)}</span>
              <span className="relative text-right" style={{ color: T.textDim }}>{total.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
      {/* Spread / last */}
      <div className="px-3 py-2 border-y flex items-center justify-between" style={{ borderColor: T.border, background: T.panel }}>
        <div style={{ color: T.textMute }} className="text-[10px] uppercase tracking-wider">Last</div>
        <div style={{ ...mono, color: last ? T.green : T.text }} className="text-[13px] font-semibold">
          {last ? `$${last.toFixed(PX_DP)}` : "—"}
        </div>
      </div>
      {/* Bids (high → low) */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {bids.length === 0 && <div style={{ color: T.textMute }} className="py-3 text-center text-[11px]">No bids</div>}
        {bids.slice(0, 12).map((r) => {
          const w = Math.max(2, Math.round((Number(r.remaining_wblob) / maxRem) * 100));
          const total = Number(r.remaining_wblob) * Number(r.price_usdc);
          return (
            <div key={r.id} className="relative grid grid-cols-3 px-1.5 py-[3px] text-[11px]" style={mono}>
              <span aria-hidden className="absolute inset-y-0 right-0" style={{ width: `${w}%`, background: T.greenSoft }} />
              <span className="relative" style={{ color: T.green }}>{Number(r.price_usdc).toFixed(PX_DP)}</span>
              <span className="relative text-right">{Number(r.remaining_wblob).toFixed(QTY_DP)}</span>
              <span className="relative text-right" style={{ color: T.textDim }}>{total.toFixed(2)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RecentTrades({ fills }: { fills: Pool.PoolFill[] }) {
  return (
    <div style={{ borderTop: `1px solid ${T.border}` }} className="px-3 py-3">
      <div style={{ color: T.text }} className="text-[11px] font-semibold uppercase tracking-wider mb-2">Recent Trades</div>
      <div className="grid grid-cols-3 text-[10px] uppercase tracking-wider pb-1.5" style={{ color: T.textMute }}>
        <div>Price (USDC)</div>
        <div className="text-right">Size (WBLOB)</div>
        <div className="text-right">Time</div>
      </div>
      <div className="max-h-[180px] overflow-y-auto">
        {fills.length === 0 && <div style={{ color: T.textMute }} className="py-6 text-center text-[11px]">No trades yet</div>}
        {fills.map((f) => {
          const px = Number(f.price_usdc) || (Number(f.usdc_amount) / Number(f.wblob_amount));
          const color = f.status === "failed" ? T.red : T.green;
          return (
            <div key={f.id} className="grid grid-cols-3 py-[3px] text-[11px]" style={mono}>
              <span style={{ color }}>{px.toFixed(PX_DP)}</span>
              <span className="text-right">{Number(f.wblob_amount).toFixed(QTY_DP)}</span>
              <span className="text-right" style={{ color: T.textDim }}>{relTime(f.created_at)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function relTime(iso: string) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.round(d)}s`;
  if (d < 3600) return `${Math.round(d / 60)}m`;
  if (d < 86400) return `${Math.round(d / 3600)}h`;
  return `${Math.round(d / 86400)}d`;
}

/* ─────────────────────── Chart (TradingView Lightweight Charts) ─────────────────────── */
type TF = "1H" | "4H" | "1D" | "1W" | "ALL";
type ChartKind = "candles" | "line" | "area";

function PriceChart({ candles, lastPrice, expanded, onToggleExpand }: { candles: Pool.Candle[]; lastPrice: number | null; expanded: boolean; onToggleExpand: () => void }) {
  const [tf, setTf] = useState<TF>("1D");
  const [kind, setKind] = useState<ChartKind>("candles");
  const [showVol, setShowVol] = useState(true);
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number; v: number; t: number } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const priceSeriesRef = useRef<any>(null);
  const volSeriesRef = useRef<any>(null);
  const lastLineRef = useRef<any>(null);
  const lastCandleTimeRef = useRef<number | null>(null);
  const initialRangeRef = useRef(false);

  // Initialize chart once
  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let chart: any;
    let ro: ResizeObserver | null = null;

    (async () => {
      const lwc = await import("lightweight-charts");
      if (disposed || !containerRef.current) return;
      chart = lwc.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 360,
        autoSize: false,
        layout: {
          background: { type: lwc.ColorType.Solid, color: T.bg },
          textColor: T.textDim,
          fontFamily: mono.fontFamily,
          fontSize: 11,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(31,39,51,0.6)", style: 1 },
          horzLines: { color: "rgba(31,39,51,0.6)", style: 1 },
        },
        rightPriceScale: {
          borderColor: T.border,
          scaleMargins: { top: 0.08, bottom: 0.22 },
          textColor: T.textDim,
        },
        timeScale: {
          borderColor: T.border,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
          barSpacing: 8,
        },
        crosshair: {
          mode: lwc.CrosshairMode.Normal,
          vertLine: { color: T.accent, width: 1, style: 2, labelBackgroundColor: T.accent },
          horzLine: { color: T.accent, width: 1, style: 2, labelBackgroundColor: T.accent },
        },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      });
      chartRef.current = chart;

      // Price series
      const priceSeries = chart.addSeries(lwc.CandlestickSeries, {
        upColor: T.green, downColor: T.red,
        borderUpColor: T.green, borderDownColor: T.red,
        wickUpColor: T.green, wickDownColor: T.red,
        priceFormat: { type: "price", precision: PX_DP, minMove: 1 / Math.pow(10, PX_DP) },
      });
      priceSeriesRef.current = priceSeries;
      (priceSeries as any).__kind = "candles";

      // Volume histogram on overlay scale
      const vol = chart.addSeries(lwc.HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
        color: T.accent,
      });
      chart.priceScale("vol").applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
        visible: false,
      });
      volSeriesRef.current = vol;

      // Crosshair → OHLC tooltip
      chart.subscribeCrosshairMove((p: any) => {
        if (!p || !p.time || !p.seriesData) { setHover(null); return; }
        const pd = p.seriesData.get(priceSeries);
        const vd = p.seriesData.get(vol);
        if (!pd) { setHover(null); return; }
        if ("open" in pd) {
          setHover({ o: pd.open, h: pd.high, l: pd.low, c: pd.close, v: vd?.value ?? 0, t: Number(p.time) });
        } else if ("value" in pd) {
          setHover({ o: pd.value, h: pd.value, l: pd.value, c: pd.value, v: vd?.value ?? 0, t: Number(p.time) });
        }
      });

      ro = new ResizeObserver(() => {
        if (!containerRef.current || !chartRef.current) return;
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      });
      ro.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      if (ro) ro.disconnect();
      try { chartRef.current?.remove(); } catch { /* */ }
      chartRef.current = null;
      priceSeriesRef.current = null;
      volSeriesRef.current = null;
      lastLineRef.current = null;
    };
  }, []);

  // Swap series type when kind changes
  useEffect(() => {
    const chart = chartRef.current;
    const cur = priceSeriesRef.current;
    if (!chart || !cur) return;
    if ((cur as any).__kind === kind) return;
    (async () => {
      const lwc = await import("lightweight-charts");
      try { chart.removeSeries(cur); } catch { /* */ }
      let ns: any;
      if (kind === "line") {
        ns = chart.addSeries(lwc.LineSeries, {
          color: T.accent, lineWidth: 2,
          priceFormat: { type: "price", precision: PX_DP, minMove: 1 / Math.pow(10, PX_DP) },
        });
      } else if (kind === "area") {
        ns = chart.addSeries(lwc.AreaSeries, {
          lineColor: T.accent, topColor: "rgba(123,156,255,0.35)", bottomColor: "rgba(123,156,255,0.02)", lineWidth: 2,
          priceFormat: { type: "price", precision: PX_DP, minMove: 1 / Math.pow(10, PX_DP) },
        });
      } else {
        ns = chart.addSeries(lwc.CandlestickSeries, {
          upColor: T.green, downColor: T.red,
          borderUpColor: T.green, borderDownColor: T.red,
          wickUpColor: T.green, wickDownColor: T.red,
          priceFormat: { type: "price", precision: PX_DP, minMove: 1 / Math.pow(10, PX_DP) },
        });
      }
      ns.__kind = kind;
      priceSeriesRef.current = ns;
      lastLineRef.current = null;
      // New series → force full reload on next feed
      lastCandleTimeRef.current = null;
      // re-feed data
      feedData(ns, volSeriesRef.current, candles, kind);
      applyLastPriceLine(ns, lastPrice);
    })();
  }, [kind]);

  // Push data on candle changes
  useEffect(() => {
    const ps = priceSeriesRef.current;
    const vs = volSeriesRef.current;
    if (!ps || !vs) return;
    feedData(ps, vs, candles, kind);
    applyLastPriceLine(ps, lastPrice);
  }, [candles, kind]);

  // Live price line
  useEffect(() => {
    const ps = priceSeriesRef.current;
    if (!ps) return;
    applyLastPriceLine(ps, lastPrice);
  }, [lastPrice]);

  function applyLastPriceLine(series: any, price: number | null) {
    if (lastLineRef.current) {
      try { series.removePriceLine(lastLineRef.current); } catch { /* */ }
      lastLineRef.current = null;
    }
    if (price && Number.isFinite(price)) {
      lastLineRef.current = series.createPriceLine({
        price, color: T.accent, lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: "",
      });
    }
  }

  function feedData(ps: any, vs: any, cs: Pool.Candle[], k: ChartKind) {
    if (!cs || cs.length === 0) {
      ps.setData([]); vs.setData([]);
      lastCandleTimeRef.current = null;
      return;
    }
    const lastSeen = lastCandleTimeRef.current;
    const fullLoad = lastSeen === null;

    if (fullLoad) {
      if (k === "candles") {
        ps.setData(cs.map((c) => ({ time: c.t as any, open: c.o, high: c.h, low: c.l, close: c.c })));
      } else {
        ps.setData(cs.map((c) => ({ time: c.t as any, value: c.c })));
      }
      vs.setData(cs.map((c) => ({
        time: c.t as any,
        value: c.v,
        color: c.c >= c.o ? "rgba(22,199,132,0.45)" : "rgba(234,57,67,0.45)",
      })));
    } else {
      // Incremental: only push bars at or after the last seen timestamp.
      // lightweight-charts `update()` replaces the bar at that time, or
      // appends if the time is newer than the last bar.
      const tail = cs.filter((c) => c.t >= lastSeen);
      for (const c of tail) {
        if (k === "candles") {
          ps.update({ time: c.t as any, open: c.o, high: c.h, low: c.l, close: c.c });
        } else {
          ps.update({ time: c.t as any, value: c.c });
        }
        vs.update({
          time: c.t as any,
          value: c.v,
          color: c.c >= c.o ? "rgba(22,199,132,0.45)" : "rgba(234,57,67,0.45)",
        });
      }
    }
    lastCandleTimeRef.current = cs[cs.length - 1].t;
  }

  // Volume visibility
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.priceScale("vol").applyOptions({ visible: false });
    const vs = volSeriesRef.current;
    if (vs) vs.applyOptions({ visible: showVol });
  }, [showVol]);

  // Apply visible range only on initial data load (once), or when user changes tf.
  // Never on every candle refresh — that would clobber the user's pan/zoom.
  function applyTimeframe(timeframe: TF) {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    if (timeframe === "ALL") { chart.timeScale().fitContent(); return; }
    const last = candles[candles.length - 1].t;
    const span = timeframe === "1H" ? 3600 : timeframe === "4H" ? 4 * 3600 : timeframe === "1D" ? 86400 : 7 * 86400;
    chart.timeScale().setVisibleRange({ from: (last - span) as any, to: (last + 60) as any });
  }

  // Initial range: apply exactly once when data first arrives.
  useEffect(() => {
    if (initialRangeRef.current) return;
    if (!chartRef.current || candles.length === 0) return;
    initialRangeRef.current = true;
    applyTimeframe(tf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles]);

  // User-triggered timeframe change.
  useEffect(() => {
    if (!initialRangeRef.current) return; // wait until initial load
    applyTimeframe(tf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tf]);

  const empty = candles.length === 0;
  const latest = candles[candles.length - 1];
  const display = hover ?? (latest ? { o: latest.o, h: latest.h, l: latest.l, c: latest.c, v: latest.v, t: latest.t } : null);
  const chg = display ? display.c - display.o : 0;
  const chgPct = display && display.o > 0 ? (chg / display.o) * 100 : 0;
  const chgColor = chg >= 0 ? T.green : T.red;

  return (
    <div className="px-4 pt-3 pb-4">
      <ChartHeader
        tf={tf} setTf={setTf}
        kind={kind} setKind={setKind}
        showVol={showVol} setShowVol={setShowVol}
        lastPrice={lastPrice}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
      />

      {/* OHLC strip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 text-[10px] uppercase tracking-wider" style={{ color: T.textMute }}>
        {display ? (
          <>
            <span>O <span style={{ ...mono, color: T.text }} className="ml-1 normal-case">{display.o.toFixed(PX_DP)}</span></span>
            <span>H <span style={{ ...mono, color: T.green }} className="ml-1 normal-case">{display.h.toFixed(PX_DP)}</span></span>
            <span>L <span style={{ ...mono, color: T.red }} className="ml-1 normal-case">{display.l.toFixed(PX_DP)}</span></span>
            <span>C <span style={{ ...mono, color: T.text }} className="ml-1 normal-case">{display.c.toFixed(PX_DP)}</span></span>
            <span style={{ ...mono, color: chgColor }} className="normal-case">
              {chg >= 0 ? "+" : ""}{chg.toFixed(PX_DP)} ({chgPct >= 0 ? "+" : ""}{chgPct.toFixed(2)}%)
            </span>
            <span>VOL <span style={{ ...mono, color: T.textDim }} className="ml-1 normal-case">{display.v.toFixed(QTY_DP)}</span></span>
          </>
        ) : (
          <span style={{ color: T.textMute }}>—</span>
        )}
      </div>

      <div className="relative rounded-md overflow-hidden" style={{ border: `1px solid ${T.border}`, background: T.bg }}>
        <div ref={containerRef} className={`w-full ${expanded ? "h-[560px]" : "h-[360px]"}`} />
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] pointer-events-none" style={{ color: T.textMute }}>
            Chart will populate as trades happen
          </div>
        )}
        <button
          onClick={() => chartRef.current?.timeScale().fitContent()}
          className="absolute bottom-2 right-2 px-2 py-1 text-[9px] uppercase tracking-wider rounded transition"
          style={{ background: T.panel, color: T.textDim, border: `1px solid ${T.border}` }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function ChartHeader({
  tf, setTf, kind, setKind, showVol, setShowVol, lastPrice, expanded, onToggleExpand,
}: {
  tf: TF; setTf: (t: TF) => void;
  kind: ChartKind; setKind: (k: ChartKind) => void;
  showVol: boolean; setShowVol: (b: boolean) => void;
  lastPrice: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-3">
        <div style={{ ...mono, color: T.text }} className="text-lg font-semibold">{lastPrice ? `$${lastPrice.toFixed(PX_DP)}` : "—"}</div>
        <div style={{ color: T.textDim }} className="text-[10px] uppercase tracking-wider">USDC / WBLOB</div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-0 max-w-full">
        <div className="flex items-center gap-px rounded-md overflow-hidden" style={{ background: T.panel, border: `1px solid ${T.border}` }}>
          {(["candles", "line", "area"] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider transition"
              style={{ color: kind === k ? T.text : T.textDim, background: kind === k ? T.panelHi : "transparent" }}>{k === "candles" ? "Candle" : k === "line" ? "Line" : "Area"}</button>
          ))}
        </div>
        <button
          onClick={() => setShowVol(!showVol)}
          className="px-2 py-1 text-[10px] font-medium uppercase tracking-wider rounded-md transition"
          style={{ background: T.panel, border: `1px solid ${T.border}`, color: showVol ? T.text : T.textDim }}
        >Vol</button>
        <div className="flex items-center gap-px rounded-md overflow-hidden" style={{ background: T.panel, border: `1px solid ${T.border}` }}>
          {(["1H", "4H", "1D", "1W", "ALL"] as const).map((t) => (
            <button key={t} onClick={() => setTf(t)} className="px-2.5 py-1 text-[10px] font-medium tracking-wider transition"
              style={{ color: tf === t ? T.text : T.textDim, background: tf === t ? T.panelHi : "transparent" }}>{t}</button>
          ))}
        </div>
        <button
          onClick={onToggleExpand}
          aria-label={expanded ? "Collapse chart" : "Expand chart"}
          title={expanded ? "Collapse chart" : "Expand chart"}
          className="hidden lg:inline-flex items-center justify-center w-7 h-7 rounded-md transition"
          style={{ background: T.panel, border: `1px solid ${T.border}`, color: expanded ? T.text : T.textDim }}
          onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
          onMouseLeave={(e) => (e.currentTarget.style.color = expanded ? T.text : T.textDim)}
        >
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────── Trade panel (unified) ─────────────────────── */
function TradePanel({ book, onDone }: { book: Pool.PoolBook | null; onDone: () => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  return (
    <div className="border-b" style={{ borderColor: T.border }}>
      <div className="grid grid-cols-2 gap-px p-2.5" style={{ background: T.panel }}>
        <button onClick={() => setSide("buy")}
          className="py-2 text-xs font-bold uppercase tracking-wider rounded-md transition"
          style={{ background: side === "buy" ? T.green : "transparent", color: side === "buy" ? "#04140C" : T.textDim }}>Buy</button>
        <button onClick={() => setSide("sell")}
          className="py-2 text-xs font-bold uppercase tracking-wider rounded-md transition"
          style={{ background: side === "sell" ? T.red : "transparent", color: side === "sell" ? "#1A0608" : T.textDim }}>Sell</button>
      </div>
      <div className="px-3 pb-3">
        <OrderForm key={side} side={side} book={book} onDone={onDone} />
      </div>
    </div>
  );
}

/* ─────────────────────── Order form (symmetric) ─────────────────────── */
function OrderForm({ side, book, onDone }: { side: "buy" | "sell"; book: Pool.PoolBook | null; onDone: () => void }) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [price, setPrice] = useState("");
  const [amt, setAmt] = useState("");
  const [bal, setBal] = useState<number | null>(null);
  const [wblobDecimals, setWblobDecimals] = useState<number>(WBLOB_DECIMALS_FALLBACK);
  const [st, setSt] = useState<"idle" | "preparing" | "signing" | "broadcasting" | "registering" | "done" | "failed">("idle");
  const [err, setErr] = useState("");
  const [doneSig, setDoneSig] = useState("");

  const escrowAddr = book?.escrow_address ?? null;
  const wblobMint = book?.wblob_mint ?? null;
  const usdcMint = book?.usdc_mint ?? null;
  // Asset escrowed depends on side
  const depositMint = side === "sell" ? wblobMint : usdcMint;
  const depositDecimals = side === "sell" ? wblobDecimals : USDC_DECIMALS;
  const depositSymbol = side === "sell" ? "WBLOB" : "USDC";

  // Load balance of the asset being deposited
  useEffect(() => {
    if (!depositMint || !publicKey) { setBal(null); return; }
    let cancel = false;
    (async () => {
      try {
        const mint = new PublicKey(depositMint);
        if (side === "sell") {
          const info = await getMint(connection, mint);
          if (!cancel) setWblobDecimals(info.decimals);
        }
        const ata = await getAssociatedTokenAddress(mint, publicKey, true);
        try {
          const r = await connection.getTokenAccountBalance(ata, "confirmed");
          if (!cancel) setBal(Number(r.value.uiAmount ?? 0));
        } catch { if (!cancel) setBal(0); }
      } catch { /* ignore */ }
    })();
    return () => { cancel = true; };
  }, [depositMint, publicKey, connection, side]);

  const parsedAmt = parseFloat(amt);
  const parsedPrice = parseFloat(price);
  const validAmt = Number.isFinite(parsedAmt) && parsedAmt > 0;
  const validPrice = Number.isFinite(parsedPrice) && parsedPrice > 0;

  const principal = side === "sell" ? parsedAmt : (validAmt && validPrice ? parsedAmt * parsedPrice : 0);
  const fee = (validAmt && validPrice) ? principal * FEE_RATE : 0;
  const totalDeposit = principal + fee;
  const enoughBal = bal === null || totalDeposit <= bal + 1e-9;
  const canSubmit = !!escrowAddr && !!depositMint && connected && st === "idle" && validAmt && validPrice && enoughBal;

  async function submit() {
    setErr(""); setDoneSig("");
    if (!escrowAddr || !depositMint) { setErr("Pool not configured"); return; }
    if (!publicKey || !signTransaction) { setErr("Connect Solana wallet"); return; }
    setSt("preparing");
    try {
      const mint = new PublicKey(depositMint);
      const escrow = new PublicKey(escrowAddr);
      const ownerAta = await getAssociatedTokenAddress(mint, publicKey, true);
      const escrowAta = await getAssociatedTokenAddress(mint, escrow, true);
      const baseUnits = BigInt(Math.round(totalDeposit * 10 ** depositDecimals));

      const solFeeLamports = BigInt(book?.sol_fee_lamports ?? "5000000");

      const ixs: TransactionInstruction[] = [
        new TransactionInstruction({
          keys: [{ pubkey: publicKey, isSigner: true, isWritable: false }],
          programId: MEMO_PROGRAM_ID,
          data: new TextEncoder().encode(`pool-${side}:${parsedPrice}:${parsedAmt}`) as unknown as Buffer,
        }),
        // Pre-pay SOL network fees the escrow will incur for releases & refunds.
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: escrow, lamports: Number(solFeeLamports) }),
        createAssociatedTokenAccountIdempotentInstruction(publicKey, escrowAta, escrow, mint),
        createTransferCheckedInstruction(ownerAta, mint, escrowAta, publicKey, baseUnits, depositDecimals),
      ];
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight });
      ixs.forEach((ix) => tx.add(ix));

      setSt("signing");
      const signed = await signTransaction(tx);
      setSt("broadcasting");
      const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 5 });
      try { await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized"); } catch { /* */ }

      setSt("registering");
      let lastErr = "";
      for (let i = 0; i < 30; i++) {
        const r = await Pool.placePoolOrder({
          side,
          owner_sol_address: publicKey.toBase58(),
          deposit_sig: sig,
          price_usdc: parsedPrice,
          amount_wblob: parsedAmt,
        });
        if (r.ok) {
          setDoneSig(sig); setSt("done"); setAmt(""); setPrice("");
          onDone();
          return;
        }
        lastErr = r.error;
        if (!/not finalized/.test(r.error)) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
      setErr(lastErr || "Registration failed"); setSt("failed");
    } catch (e: any) { setErr(String(e?.message ?? e)); setSt("failed"); }
  }

  const actionColor = side === "buy" ? T.green : T.red;
  const actionTextColor = side === "buy" ? "#04140C" : "#fff";

  return (
    <div className="space-y-2.5 pt-3">
      <ConnectRow connected={connected} />

      <Field label={side === "buy" ? "Bid Price" : "Ask Price"} suffix="USDC">
        <ProInput value={price} onChange={setPrice} placeholder="0.000000" />
      </Field>

      <Field
        label="Amount"
        suffix="WBLOB"
        right={bal !== null && side === "sell" && bal > 0 ? (
          <button onClick={() => setAmt(((bal / (1 + FEE_RATE))).toFixed(QTY_DP))} style={{ color: T.textDim }} className="text-[10px] hover:text-white">
            Bal: <span style={mono}>{bal.toFixed(QTY_DP)}</span>
          </button>
        ) : null}
      >
        <ProInput value={amt} onChange={setAmt} placeholder="0.0000" />
      </Field>

      {bal !== null && bal > 0 && (
        <PercentRow onPick={(pct) => {
          if (side === "sell") {
            // Use up to (bal / (1+fee)) so principal+fee fits.
            setAmt(((bal / (1 + FEE_RATE)) * (pct / 100)).toFixed(QTY_DP));
          } else {
            // Buy: amount derives from USDC bal & price.
            if (!validPrice) return;
            const usableUsdc = (bal / (1 + FEE_RATE)) * (pct / 100);
            setAmt((usableUsdc / parsedPrice).toFixed(QTY_DP));
          }
        }} />
      )}

      <div className="rounded-md p-2.5 text-[11px] space-y-1.5" style={{ background: T.panel, border: `1px solid ${T.border}` }}>
        <Row k={side === "buy" ? "Cost (USDC)" : "Notional (USDC)"} v={validAmt && validPrice ? `$${(parsedAmt * parsedPrice).toFixed(PX_DP)}` : "—"} />
        <Row k="Protocol fee (1%)" v={validAmt && validPrice ? `${fee.toFixed(side === "sell" ? QTY_DP : PX_DP)} ${depositSymbol}` : "—"} dim />
        <Row k="Network fee (SOL)" v={`${(Number(book?.sol_fee_lamports ?? "5000000") / LAMPORTS_PER_SOL).toFixed(4)} SOL`} dim />
        <div className="h-px my-0.5" style={{ background: T.border }} />
        <Row k="You deposit" v={validAmt && validPrice ? `${totalDeposit.toFixed(side === "sell" ? QTY_DP : PX_DP)} ${depositSymbol}` : "—"} accent={T.text} bold />
        <div style={{ color: T.textMute }} className="text-[10px] pt-0.5 leading-relaxed">
          Order is matched against the opposite book on placement. Unfilled remainder rests at your price. Cancel any time to refund principal + fee on the unfilled portion. Unused SOL network-fee budget is refunded on cancel.
        </div>
      </div>

      {!connected && validAmt && validPrice && (
        <div className="text-[11px]" style={{ color: T.textDim }}>Connect wallet to place order</div>
      )}

      {connected && bal !== null && !enoughBal && validAmt && validPrice && (
        <div className="text-[11px]" style={{ color: T.red }}>Insufficient {depositSymbol} balance (need {totalDeposit.toFixed(side === "sell" ? QTY_DP : PX_DP)})</div>
      )}

      {err && <ErrorBlock msg={err} />}
      {st === "done" && doneSig && (
        <SuccessBlock>
          <span style={{ color: T.green }} className="inline-flex items-center gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Order placed</span>
          <a href={`https://solscan.io/tx/${doneSig}`} target="_blank" rel="noreferrer" style={{ ...mono, color: T.accent }} className="hover:underline inline-flex items-center gap-1 truncate">{doneSig.slice(0, 14)}…<ExternalLink className="w-3 h-3" /></a>
        </SuccessBlock>
      )}

      <ProButton
        color={actionColor}
        textColor={actionTextColor}
        onClick={connected ? submit : () => setVisible(true)}
        disabled={connected ? !canSubmit : false}
        label={
          !connected ? "Connect Wallet" :
          st === "idle" || st === "done" || st === "failed" ? `Place ${side === "buy" ? "Buy" : "Sell"} Order` :
          st === "preparing" ? "Preparing…" :
          st === "signing" ? "Awaiting signature…" :
          st === "broadcasting" ? "Depositing…" :
          "Registering…"
        }
        busy={st !== "idle" && st !== "done" && st !== "failed"}
        icon={<ArrowDownUp className="w-3.5 h-3.5" />}
      />
    </div>
  );
}

/* ─────────────────────── Shared UI primitives ─────────────────────── */
function ConnectRow({ connected }: { connected: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <div style={{ color: T.textDim }} className="text-[10px] uppercase tracking-widest">{connected ? "Wallet Connected" : "Wallet Required"}</div>
      <WalletMultiButton style={{
        background: T.panelHi, border: `1px solid ${T.border}`, borderRadius: 6,
        height: 26, fontSize: 10, padding: "0 8px", color: T.text, fontWeight: 500,
        textTransform: "uppercase", letterSpacing: "0.05em",
      }} />
    </div>
  );
}
function Field({ label, suffix, right, children }: { label: string; suffix?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span style={{ color: T.textDim }} className="text-[10px] uppercase tracking-widest">{label}</span>
        {right}
      </div>
      <div className="relative">
        {children}
        {suffix && <span style={{ ...mono, color: T.textMute }} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] uppercase pointer-events-none">{suffix}</span>}
      </div>
    </div>
  );
}
function ProInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} inputMode="decimal"
      style={{ ...mono, background: T.panel, border: `1px solid ${T.border}`, color: T.text, width: "100%", height: 36, borderRadius: 6, padding: "0 56px 0 10px", fontSize: 13, outline: "none" }}
      onFocus={(e) => (e.currentTarget.style.borderColor = T.borderHi)}
      onBlur={(e) => (e.currentTarget.style.borderColor = T.border)} />
  );
}
function PercentRow({ onPick }: { onPick: (pct: number) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {[25, 50, 75, 100].map((p) => (
        <button key={p} onClick={() => onPick(p)} className="py-1 text-[10px] font-medium rounded transition"
          style={{ background: T.panel, border: `1px solid ${T.border}`, color: T.textDim }}
          onMouseEnter={(e) => { e.currentTarget.style.color = T.text; e.currentTarget.style.borderColor = T.borderHi; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = T.textDim; e.currentTarget.style.borderColor = T.border; }}>
          {p}%
        </button>
      ))}
    </div>
  );
}
function Row({ k, v, dim, accent, bold }: { k: string; v: string; dim?: boolean; accent?: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: dim ? T.textMute : T.textDim }} className="text-[11px]">{k}</span>
      <span style={{ ...mono, color: accent ?? (dim ? T.textDim : T.text), fontWeight: bold ? 600 : 400 }} className="text-[12px]">{v}</span>
    </div>
  );
}
function ErrorBlock({ msg }: { msg: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md p-2 text-[11px]" style={{ background: T.redSoft, border: `1px solid ${T.red}40`, color: T.red }}>
      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /><span className="break-words">{msg}</span>
    </div>
  );
}
function SuccessBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md p-2.5 text-[11px] space-y-1 flex flex-col" style={{ background: T.greenSoft, border: `1px solid ${T.green}40` }}>
      {children}
    </div>
  );
}
function ProButton({ color, textColor, onClick, disabled, label, busy, icon }: {
  color: string; textColor: string; onClick: () => void; disabled: boolean; label: string; busy?: boolean; icon?: React.ReactNode;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md text-[12px] font-bold uppercase tracking-wider transition disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ background: color, color: textColor }}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
      {label}
    </button>
  );
}

/* ─────────────────────── My orders ─────────────────────── */
function MyOrders({ mine, onDone }: { mine: Pool.PoolOrder[]; onDone: () => void }) {
  const { publicKey, signMessage } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);

  async function cancel(o: Pool.PoolOrder) {
    if (!signMessage) return;
    setBusy(o.id);
    try {
      const ts = Date.now();
      const msg = new TextEncoder().encode(`pool-cancel:${o.id}:${ts}`);
      const sig = await signMessage(msg);
      const sigB58 = bs58.encode(sig);
      await Pool.cancelPoolOrder({ order_id: o.id, ts, signature_b58: sigB58 });
      onDone();
    } finally { setBusy(null); }
  }

  return (
    <div className="px-3 py-3">
      <div style={{ color: T.text }} className="text-[11px] font-semibold uppercase tracking-wider mb-2">Open Orders</div>
      {!publicKey && <div style={{ color: T.textMute }} className="text-[11px]">Connect a wallet to see your orders.</div>}
      {publicKey && mine.length === 0 && <div style={{ color: T.textMute }} className="text-[11px]">No orders yet.</div>}
      <div className="space-y-1.5 max-h-[260px] overflow-y-auto">
        {mine.map((o) => {
          const stColor: Record<string, string> = {
            open: T.accent, partial: T.accent, pending_deposit: T.textDim,
            cancelling: T.textDim, cancelled: T.red, filled: T.green, failed: T.red,
          };
          const sideColor = o.side === "buy" ? T.green : T.red;
          return (
            <div key={o.id} className="rounded-md p-2 text-[11px] space-y-1.5" style={{ background: T.panel, border: `1px solid ${T.border}` }}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center justify-end gap-1.5 min-w-0 max-w-full">
                  <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-bold"
                    style={{ background: `${sideColor}20`, color: sideColor }}>{o.side}</span>
                  <span className="px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider font-semibold"
                    style={{ background: `${stColor[o.status] ?? T.textDim}20`, color: stColor[o.status] ?? T.textDim }}>{o.status}</span>
                </div>
                {(o.status === "open" || o.status === "partial" || o.status === "pending_deposit") && (
                  <button onClick={() => cancel(o)} disabled={busy === o.id}
                    className="text-[10px] inline-flex items-center gap-1 transition disabled:opacity-50"
                    style={{ color: T.textDim }}
                    onMouseEnter={(e) => (e.currentTarget.style.color = T.red)}
                    onMouseLeave={(e) => (e.currentTarget.style.color = T.textDim)}>
                    {busy === o.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />} Cancel
                  </button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2" style={mono}>
                <Cell k="Price" v={`$${Number(o.price_usdc).toFixed(PX_DP)}`} />
                <Cell k="Filled" v={`${(Number(o.amount_wblob) - Number(o.remaining_wblob)).toFixed(QTY_DP)} / ${Number(o.amount_wblob).toFixed(QTY_DP)}`} />
                <Cell k="Remaining" v={Number(o.remaining_wblob).toFixed(QTY_DP)} />
              </div>
              {o.error && <div style={{ color: T.red }} className="text-[10px]">{o.error}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div style={{ color: T.textMute }} className="text-[9px] uppercase tracking-wider">{k}</div>
      <div style={{ color: T.text }} className="text-[11px]">{v}</div>
    </div>
  );
}