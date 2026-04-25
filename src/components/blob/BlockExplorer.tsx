// @ts-nocheck
import { useEffect, useMemo, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import { ChevronDown, SlidersHorizontal, X, Search, HandCoins, ArrowUpRight, ArrowDownLeft, Trophy } from "lucide-react";
import {
  ExplorerTx, flattenChainTxs, mempoolToTxs, shortHash, timeAgo,
  TxFilters, BlockFilters, AddrFilters,
  emptyTxFilters, emptyBlockFilters, emptyAddrFilters,
  applyTxFilters, txFiltersActive, blockFiltersActive, addrFiltersActive, dateToTs,
} from "@/lib/blob/explorer";
import { PAGE_SIZE } from "@/lib/blob/constants";
import MempoolView from "./MempoolView";

function ExplorerStat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="glass px-4 py-3">
      <div className="label-eyebrow mb-1.5">{label}</div>
      <div className="text-base font-medium num text-foreground/90">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground num mt-0.5">{sub}</div>}
    </div>
  );
}

function ExplorerTabBtn({ active, onClick, children, count }: any) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-xs font-medium tracking-wide transition border-b ${
        active
          ? "text-[hsl(var(--warning))] border-[hsl(var(--warning))]"
          : "text-muted-foreground border-transparent hover:text-foreground/80"
      }`}
    >
      {children}
      {typeof count === "number" && (
        <span className="ml-1.5 num text-[10px] text-muted-foreground">({count})</span>
      )}
    </button>
  );
}

function Pager({ page, setPage, total, label }: { page: number; setPage: (n: number) => void; total: number; label: string }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total <= PAGE_SIZE) return null;
  const start = page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, total);
  return (
    <div className="glass flex items-center justify-between px-3 py-2 text-xs">
      <span className="text-muted-foreground num">{start}–{end} of {total} {label}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => setPage(0)} disabled={page === 0}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">«</button>
        <button onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">‹</button>
        <span className="num text-muted-foreground px-2">page {page + 1} / {pages}</span>
        <button onClick={() => setPage(Math.min(pages - 1, page + 1))} disabled={page >= pages - 1}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">›</button>
        <button onClick={() => setPage(pages - 1)} disabled={page >= pages - 1}
          className="px-2 py-1 hover:bg-secondary/40 disabled:opacity-30 disabled:cursor-not-allowed transition">»</button>
      </div>
    </div>
  );
}

function FInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full bg-background/40 border border-border px-2 py-1.5 text-xs num focus:outline-none focus:border-[hsl(var(--warning))] placeholder:text-muted-foreground/60 placeholder:font-sans ${props.className || ""}`}
    />
  );
}
function FSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { v: string; l: string }[] }) {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-background/40 border border-border px-2 py-1.5 text-xs focus:outline-none focus:border-[hsl(var(--warning))]">
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="label-eyebrow mb-1">{children}</div>;
}
function FilterPanel({ activeCount, onClear, defaultOpen = false, children }: { activeCount: number; onClear: () => void; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="glass">
      <div className="flex items-center justify-between px-3 py-2">
        <button onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 text-xs text-foreground/80 hover:text-foreground transition">
          <SlidersHorizontal className="w-3.5 h-3.5" />
          <span className="label-eyebrow !mb-0">Filters</span>
          {activeCount > 0 && (
            <span className="num text-[10px] px-1.5 py-0.5 bg-[hsl(var(--warning)/0.15)] text-[hsl(var(--warning))]">
              {activeCount}
            </span>
          )}
          <ChevronDown className={`w-3 h-3 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
        {activeCount > 0 && (
          <button onClick={onClear}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition">
            <X className="w-3 h-3" /> clear all
          </button>
        )}
      </div>
      {open && <div className="border-t border-border/60 p-3">{children}</div>}
    </div>
  );
}

export default function BlockExplorer({ chain, blockInfo, mempool }: any) {
  const [tab, setTab] = useState<"overview" | "blocks" | "txs" | "mempool" | "addresses">("overview");
  const [query, setQuery] = useState("");
  const [selBlock, setSelBlock] = useState<number | null>(null);
  const [selTx, setSelTx] = useState<string | null>(null);
  const [selAddr, setSelAddr] = useState<string | null>(null);
  const [players, setPlayers] = useState<Relay.Player[]>([]);

  const [pBlocks, setPBlocks] = useState(0);
  const [pTxs, setPTxs] = useState(0);
  const [pMem, setPMem] = useState(0);
  const [pAddr, setPAddr] = useState(0);

  const [txF, setTxF] = useState<TxFilters>(emptyTxFilters);
  const [memF, setMemF] = useState<TxFilters>(emptyTxFilters);
  const [blkF, setBlkF] = useState<BlockFilters>(emptyBlockFilters);
  const [addrF, setAddrF] = useState<AddrFilters>(emptyAddrFilters);

  useEffect(() => { setPBlocks(0); setPTxs(0); setPMem(0); setPAddr(0); }, [tab]);
  useEffect(() => { setPTxs(0); }, [txF]);
  useEffect(() => { setPMem(0); }, [memF]);
  useEffect(() => { setPBlocks(0); }, [blkF]);
  useEffect(() => { setPAddr(0); }, [addrF]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await Relay.fetchPlayers();
      if (!cancelled) setPlayers(p);
    })();
    return () => { cancelled = true; };
  }, [chain.length, mempool.length]);

  const allTxs = useMemo(() => flattenChainTxs(chain), [chain]);
  const memTxs = useMemo(() => mempoolToTxs(mempool || []), [mempool]);

  const addressBook = useMemo(() => {
    const m = new Map<string, { address: string; sent: number; received: number; mined: number; txCount: number; lastSeen: number }>();
    for (const p of players) {
      m.set(p.address, {
        address: p.address,
        sent: 0, received: 0, mined: 0, txCount: 0,
        lastSeen: p.lastActive ? new Date(p.lastActive).getTime() : 0,
      });
    }
    const touch = (addr: string) => {
      if (!addr || addr === "coinbase") return;
      if (!m.has(addr)) m.set(addr, { address: addr, sent: 0, received: 0, mined: 0, txCount: 0, lastSeen: 0 });
      return m.get(addr)!;
    };
    for (const tx of allTxs) {
      const ts = tx.timestamp;
      if (tx.kind === "reward") {
        const e = touch(tx.to); if (e) { e.mined += tx.amount; e.lastSeen = Math.max(e.lastSeen, ts); }
      } else {
        const f = touch(tx.from);
        const t = touch(tx.to);
        if (f) { f.sent += tx.amount + tx.fee; f.txCount++; f.lastSeen = Math.max(f.lastSeen, ts); }
        if (t) { t.received += tx.amount; t.txCount++; t.lastSeen = Math.max(t.lastSeen, ts); }
      }
    }
    return Array.from(m.values()).sort((a, b) => (b.mined + b.received) - (a.mined + a.received));
  }, [allTxs, players]);

  const txsAll = useMemo(() => [...memTxs, ...allTxs], [memTxs, allTxs]);
  const txsFiltered = useMemo(() => applyTxFilters(txsAll, txF), [txsAll, txF]);
  const memFiltered = useMemo(() => applyTxFilters(memTxs, memF), [memTxs, memF]);

  const blocksFiltered = useMemo(() => {
    const winner = blkF.winner.trim().toLowerCase();
    const minH = blkF.minHeight === "" ? null : Number(blkF.minHeight);
    const maxH = blkF.maxHeight === "" ? null : Number(blkF.maxHeight);
    const from = dateToTs(blkF.dateFrom);
    const to = dateToTs(blkF.dateTo, true);
    const out = (chain as any[]).filter(b => {
      if (winner) {
        const ok = (b.winner || "").toLowerCase().includes(winner);
        if (!ok) return false;
      }
      if (minH !== null && b.height < minH) return false;
      if (maxH !== null && b.height > maxH) return false;
      if (from !== null && b.timestamp < from) return false;
      if (to !== null && b.timestamp > to) return false;
      const txCount = (b.transactions || []).length;
      if (blkF.hasTxs === "yes" && txCount === 0) return false;
      if (blkF.hasTxs === "no" && txCount > 0) return false;
      return true;
    });
    switch (blkF.sort) {
      case "oldest": out.sort((a, b) => a.height - b.height); break;
      case "reward-desc": out.sort((a, b) => Number(b.reward || 0) - Number(a.reward || 0)); break;
      case "score-desc": out.sort((a, b) => (b.winnerScore || 0) - (a.winnerScore || 0)); break;
      default: out.sort((a, b) => b.height - a.height);
    }
    return out;
  }, [chain, blkF]);

  const addrFiltered = useMemo(() => {
    const q = addrF.q.trim().toLowerCase();
    const minB = addrF.minBalance === "" ? null : Number(addrF.minBalance);
    const out = addressBook.filter(a => {
      if (q && !a.address.toLowerCase().includes(q)) return false;
      const bal = a.received + a.mined - a.sent;
      if (minB !== null && bal < minB) return false;
      if (addrF.hasMined === "yes" && a.mined <= 0) return false;
      if (addrF.hasMined === "no" && a.mined > 0) return false;
      if (addrF.hasTxs === "yes" && a.txCount === 0) return false;
      if (addrF.hasTxs === "no" && a.txCount > 0) return false;
      return true;
    });
    switch (addrF.sort) {
      case "balance-asc": out.sort((a, b) => (a.received + a.mined - a.sent) - (b.received + b.mined - b.sent)); break;
      case "mined-desc": out.sort((a, b) => b.mined - a.mined); break;
      case "tx-desc": out.sort((a, b) => b.txCount - a.txCount); break;
      case "recent": out.sort((a, b) => b.lastSeen - a.lastSeen); break;
      default: out.sort((a, b) => (b.received + b.mined - b.sent) - (a.received + a.mined - a.sent));
    }
    return out;
  }, [addressBook, addrF]);

  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!q) return null;
    const blocks = chain.filter((b: any) =>
      String(b.height).includes(q) ||
      b.hash?.toLowerCase().includes(q) ||
      b.previousHash?.toLowerCase().includes(q) ||
      b.winner?.toLowerCase().includes(q) ||
      b.seed?.toLowerCase().includes(q)
    ).slice(0, 10);
    const txs = [...memTxs, ...allTxs].filter(t =>
      t.id.toLowerCase().includes(q) ||
      t.signature?.toLowerCase().includes(q) ||
      t.from?.toLowerCase().includes(q) ||
      t.to?.toLowerCase().includes(q) ||
      String(t.amount).includes(q)
    ).slice(0, 15);
    const addresses = addressBook.filter(a =>
      a.address.toLowerCase().includes(q) ||
      (q === "blob" && a.address === "coinbase")
    ).slice(0, 10);
    return { blocks, txs, addresses };
  }, [q, chain, allTxs, memTxs, addressBook]);

  const totalSupply = chain.reduce((s: number, b: any) => s + Number(b.reward || 0), 0);
  const totalTxs = allTxs.filter(t => t.kind === "transfer").length;
  const totalVolume = allTxs.filter(t => t.kind === "transfer").reduce((s, t) => s + t.amount, 0);
  const lastBlock = chain[chain.length - 1];

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="glass-hi p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by block #, address, tx hash, signature, seed…"
            className="w-full bg-background/40 border border-border rounded-none pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:border-[hsl(var(--warning))] num placeholder:font-sans placeholder:text-muted-foreground"
          />
        </div>
        {q && searchResults && (
          <div className="mt-3 space-y-2 max-h-80 overflow-y-auto">
            {searchResults.blocks.length === 0 && searchResults.txs.length === 0 && searchResults.addresses.length === 0 && (
              <div className="text-xs text-muted-foreground text-center py-4">No results for "{query}"</div>
            )}
            {searchResults.blocks.length > 0 && (
              <div>
                <div className="label-eyebrow mb-1.5">Blocks · {searchResults.blocks.length}</div>
                {searchResults.blocks.map((b: any) => (
                  <button key={b.height} onClick={() => { setTab("blocks"); setSelBlock(b.height); setQuery(""); }}
                    className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between text-xs">
                    <span className="num text-[hsl(var(--warning))]">#{b.height}</span>
                    <span className="num text-muted-foreground truncate mx-2">{shortHash(b.hash, 10)}</span>
                    <span className="text-foreground/70">{shortHash(b.winner, 6)}</span>
                  </button>
                ))}
              </div>
            )}
            {searchResults.txs.length > 0 && (
              <div>
                <div className="label-eyebrow mb-1.5">Transactions · {searchResults.txs.length}</div>
                {searchResults.txs.map(t => (
                  <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); setQuery(""); }}
                    className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between text-xs">
                    <span className="num text-muted-foreground">{shortHash(t.id, 8)}</span>
                    <span className="num text-primary/80">{t.amount} BLOB</span>
                    <span className={`text-[10px] ${t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-foreground/60"}`}>
                      {t.status === "pending" ? "pending" : `block #${t.block}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {searchResults.addresses.length > 0 && (
              <div>
                <div className="label-eyebrow mb-1.5">Addresses · {searchResults.addresses.length}</div>
                {searchResults.addresses.map(a => (
                  <button key={a.address} onClick={() => { setTab("addresses"); setSelAddr(a.address); setQuery(""); }}
                    className="w-full text-left glass px-3 py-2 mb-1 hover:bg-secondary/30 transition flex items-center justify-between text-xs">
                    <span className="text-foreground/80">{a.address === "coinbase" ? "blob" : shortHash(a.address, 6)}</span>
                    <span className="num text-muted-foreground truncate mx-2">{shortHash(a.address, 8)}</span>
                    <span className="num text-primary/80">{(a.received + a.mined - a.sent).toFixed(2)} BLOB</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="glass-hi flex items-center gap-1 px-2 overflow-x-auto">
        <ExplorerTabBtn active={tab === "overview"} onClick={() => setTab("overview")}>Overview</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "blocks"} onClick={() => setTab("blocks")} count={chain.length}>Blocks</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "txs"} onClick={() => setTab("txs")} count={allTxs.length}>Transactions</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "mempool"} onClick={() => setTab("mempool")} count={memTxs.length}>Mempool</ExplorerTabBtn>
        <ExplorerTabBtn active={tab === "addresses"} onClick={() => setTab("addresses")} count={addressBook.length}>Addresses</ExplorerTabBtn>
      </div>

      {tab === "overview" && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <ExplorerStat label="Latest block" value={`#${blockInfo.height - 1}`} sub={lastBlock ? timeAgo(lastBlock.timestamp) : "—"} />
            <ExplorerStat label="Total supply" value={`${totalSupply.toFixed(2)}`} sub="BLOB minted" />
            <ExplorerStat label="Transactions" value={totalTxs} sub={`${totalVolume.toFixed(2)} BLOB volume`} />
            <ExplorerStat label="Pending" value={memTxs.length} sub="in mempool" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="label-eyebrow">Latest blocks</span>
                <button onClick={() => setTab("blocks")} className="text-[10px] text-[hsl(var(--warning))] hover:underline">View all →</button>
              </div>
              {[...chain].reverse().slice(0, 6).map((b: any) => (
                <button key={b.height} onClick={() => { setTab("blocks"); setSelBlock(b.height); }}
                  className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                  <span className="num text-[hsl(var(--warning))] shrink-0">#{b.height}</span>
                  <span className="text-foreground/80 truncate flex-1">{shortHash(b.winner, 6)}</span>
                  <span className="num text-muted-foreground shrink-0">{(b.transactions || []).length} tx</span>
                  <span className="num text-primary/80 shrink-0">{Number(b.reward).toFixed(0)} BLOB</span>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="label-eyebrow">Latest transactions</span>
                <button onClick={() => setTab("txs")} className="text-[10px] text-[hsl(var(--warning))] hover:underline">View all →</button>
              </div>
              {[...memTxs, ...allTxs].slice(0, 6).map(t => (
                <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); }}
                  className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                  {t.kind === "reward"
                    ? <HandCoins className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0" />
                    : <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <span className="num text-muted-foreground truncate flex-1">{shortHash(t.id, 6)}</span>
                  <span className="num text-primary/80 shrink-0">{t.amount} BLOB</span>
                  <span className={`text-[10px] shrink-0 ${t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-muted-foreground"}`}>
                    {t.status === "pending" ? "pending" : timeAgo(t.timestamp)}
                  </span>
                </button>
              ))}
              {allTxs.length === 0 && memTxs.length === 0 && (
                <div className="glass text-center py-6 text-xs text-muted-foreground">No transactions yet</div>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === "blocks" && (
        <div className="space-y-1.5">
          <FilterPanel activeCount={blockFiltersActive(blkF)} onClear={() => setBlkF(emptyBlockFilters)}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="col-span-2 sm:col-span-3 lg:col-span-2">
                <FieldLabel>Winner address</FieldLabel>
                <FInput value={blkF.winner} onChange={e => setBlkF({ ...blkF, winner: e.target.value })} placeholder="address" />
              </div>
              <div>
                <FieldLabel>Min height</FieldLabel>
                <FInput type="number" value={blkF.minHeight} onChange={e => setBlkF({ ...blkF, minHeight: e.target.value })} placeholder="0" />
              </div>
              <div>
                <FieldLabel>Max height</FieldLabel>
                <FInput type="number" value={blkF.maxHeight} onChange={e => setBlkF({ ...blkF, maxHeight: e.target.value })} placeholder="∞" />
              </div>
              <div>
                <FieldLabel>From date</FieldLabel>
                <FInput type="date" value={blkF.dateFrom} onChange={e => setBlkF({ ...blkF, dateFrom: e.target.value })} />
              </div>
              <div>
                <FieldLabel>To date</FieldLabel>
                <FInput type="date" value={blkF.dateTo} onChange={e => setBlkF({ ...blkF, dateTo: e.target.value })} />
              </div>
              <div>
                <FieldLabel>Has transactions</FieldLabel>
                <FSelect value={blkF.hasTxs} onChange={v => setBlkF({ ...blkF, hasTxs: v as any })}
                  options={[{ v: "all", l: "Any" }, { v: "yes", l: "With txs" }, { v: "no", l: "Empty blocks" }]} />
              </div>
              <div>
                <FieldLabel>Sort by</FieldLabel>
                <FSelect value={blkF.sort} onChange={v => setBlkF({ ...blkF, sort: v as any })}
                  options={[{ v: "newest", l: "Newest" }, { v: "oldest", l: "Oldest" }, { v: "reward-desc", l: "Highest reward" }, { v: "score-desc", l: "Highest score" }]} />
              </div>
            </div>
          </FilterPanel>
          <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground num">
            <span>{blocksFiltered.length} of {chain.length} blocks</span>
          </div>
          <div className="glass-hi px-3 py-2.5 ring-1 ring-[hsl(var(--warning)/0.2)] grid grid-cols-[50px_1fr_60px_70px_40px] sm:grid-cols-[60px_1fr_80px_100px_50px] gap-2 items-center text-xs">
            <span className="num text-[hsl(var(--warning))]">#{blockInfo.height}</span>
            <span className="text-muted-foreground">{blockInfo.awaitingMiner ? "⏸ awaiting miner" : `⏳ mining · ${blockInfo.remaining}s`}</span>
            <span className="text-muted-foreground">—</span>
            <span className="num text-[hsl(var(--warning))]">{blockInfo.reward} BLOB</span>
            <span className="num text-right text-muted-foreground">—</span>
          </div>
          <div className="grid grid-cols-[50px_1fr_60px_70px_40px] sm:grid-cols-[60px_1fr_80px_100px_50px] gap-2 px-3 py-1">
            {["Height", "Winner", "Score", "Reward", "Tx"].map(h => <div key={h} className="label-eyebrow">{h}</div>)}
          </div>
          {blocksFiltered.slice(pBlocks * PAGE_SIZE, (pBlocks + 1) * PAGE_SIZE).map((b: any) => (
            <div key={b.height}>
              <div onClick={() => setSelBlock(selBlock === b.height ? null : b.height)}
                className="glass px-3 py-2.5 cursor-pointer hover:bg-secondary/30 transition grid grid-cols-[50px_1fr_60px_70px_40px] sm:grid-cols-[60px_1fr_80px_100px_50px] gap-2 items-center text-xs">
                <span className="num text-muted-foreground">#{b.height}</span>
                <span className="truncate text-foreground/80">{shortHash(b.winner, 8)}</span>
                <span className="num text-muted-foreground">{b.winnerScore > 0 ? b.winnerScore : "—"}</span>
                <span className="num text-primary/80">{b.reward > 0 ? `${b.reward} BLOB` : "—"}</span>
                <span className="num text-right text-muted-foreground">{(b.transactions || []).length}</span>
              </div>
              {selBlock === b.height && (
                <div className="glass-hi mt-1 p-3 text-xs space-y-1.5 overflow-x-auto">
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Hash</span><span className="num text-foreground/70 break-all">{b.hash}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Prev</span><span className="num text-foreground/70 break-all">{b.previousHash}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Seed</span><span className="num">{b.seed}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Time</span><span>{new Date(b.timestamp).toLocaleString()} · {timeAgo(b.timestamp)}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="label-eyebrow">Winner</span>
                    <button onClick={() => { setTab("addresses"); setSelAddr(b.winner); }}
                      className="num text-[hsl(var(--warning))] hover:underline text-left break-all">{b.winner || "—"}</button>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Mining entries</span><span className="num">{(b.miningEntries || []).length}</span></div>
                  {(b.transactions || []).length > 0 && (
                    <div className="pt-1.5 border-t border-border/50">
                      <div className="label-eyebrow mb-1">Transactions ({b.transactions.length})</div>
                      {b.transactions.map((tx: any, i: number) => (
                        <div key={i} className="num text-foreground/60 text-[11px]">
                          {tx.from === "coinbase" ? "blob" : shortHash(tx.from, 6)} → {shortHash(tx.to, 6)} · {tx.amount} BLOB · fee {tx.fee || 0}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <Pager page={pBlocks} setPage={setPBlocks} total={blocksFiltered.length} label="blocks" />
          {chain.length === 0 ? (
            <div className="glass text-center py-10 text-sm text-muted-foreground">Chain starts at genesis</div>
          ) : blocksFiltered.length === 0 && (
            <div className="glass text-center py-10 text-xs text-muted-foreground">No blocks match these filters</div>
          )}
        </div>
      )}

      {tab === "txs" && (
        <div className="space-y-1.5">
          <FilterPanel activeCount={txFiltersActive(txF)} onClear={() => setTxF(emptyTxFilters)}>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="col-span-2 sm:col-span-2">
                <FieldLabel>Address (from / to)</FieldLabel>
                <FInput value={txF.addr} onChange={e => setTxF({ ...txF, addr: e.target.value })} placeholder="address" />
              </div>
              <div>
                <FieldLabel>Side</FieldLabel>
                <FSelect value={txF.addrSide} onChange={v => setTxF({ ...txF, addrSide: v as any })}
                  options={[{ v: "any", l: "Either" }, { v: "from", l: "Sender (from)" }, { v: "to", l: "Recipient (to)" }]} />
              </div>
              <div>
                <FieldLabel>Type</FieldLabel>
                <FSelect value={txF.kind} onChange={v => setTxF({ ...txF, kind: v as any })}
                  options={[{ v: "all", l: "All" }, { v: "transfer", l: "Transfers" }, { v: "reward", l: "Block rewards" }]} />
              </div>
              <div>
                <FieldLabel>Min amount BLOB</FieldLabel>
                <FInput type="number" value={txF.minAmount} onChange={e => setTxF({ ...txF, minAmount: e.target.value })} placeholder="0" />
              </div>
              <div>
                <FieldLabel>Max amount BLOB</FieldLabel>
                <FInput type="number" value={txF.maxAmount} onChange={e => setTxF({ ...txF, maxAmount: e.target.value })} placeholder="∞" />
              </div>
              <div>
                <FieldLabel>From date</FieldLabel>
                <FInput type="date" value={txF.dateFrom} onChange={e => setTxF({ ...txF, dateFrom: e.target.value })} />
              </div>
              <div>
                <FieldLabel>To date</FieldLabel>
                <FInput type="date" value={txF.dateTo} onChange={e => setTxF({ ...txF, dateTo: e.target.value })} />
              </div>
              <div>
                <FieldLabel>Status</FieldLabel>
                <FSelect value={txF.status} onChange={v => setTxF({ ...txF, status: v as any })}
                  options={[{ v: "all", l: "All" }, { v: "confirmed", l: "Confirmed" }, { v: "pending", l: "Pending" }]} />
              </div>
              <div>
                <FieldLabel>Sort by</FieldLabel>
                <FSelect value={txF.sort} onChange={v => setTxF({ ...txF, sort: v as any })}
                  options={[{ v: "newest", l: "Newest" }, { v: "oldest", l: "Oldest" }, { v: "amount-desc", l: "Largest amount" }, { v: "amount-asc", l: "Smallest amount" }]} />
              </div>
            </div>
          </FilterPanel>
          <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground num">
            <span>{txsFiltered.length} of {txsAll.length} transactions</span>
            {txsFiltered.length > 0 && (
              <span>volume {txsFiltered.reduce((s, t) => s + t.amount, 0).toFixed(2)} BLOB</span>
            )}
          </div>
          <div className="grid grid-cols-[18px_1fr_70px_60px_60px] sm:grid-cols-[18px_1fr_1fr_80px_70px_80px] gap-2 px-3 py-1">
            {["", "From", "To", "Amount", "Block", "Time"].slice(0, window.innerWidth < 640 ? 5 : 6).map(h => <div key={h} className="label-eyebrow">{h}</div>)}
          </div>
          {txsFiltered.length === 0 && (
            <div className="glass text-center py-10 text-sm text-muted-foreground">
              {txsAll.length === 0 ? "No transactions yet" : "No transactions match these filters"}
            </div>
          )}
          {txsFiltered.slice(pTxs * PAGE_SIZE, (pTxs + 1) * PAGE_SIZE).map(t => (
            <div key={t.id}>
              <div onClick={() => setSelTx(selTx === t.id ? null : t.id)}
                className="glass px-3 py-2.5 cursor-pointer hover:bg-secondary/30 transition grid grid-cols-[18px_1fr_70px_60px_60px] sm:grid-cols-[18px_1fr_1fr_80px_70px_80px] gap-2 items-center text-xs">
                {t.kind === "reward"
                  ? <HandCoins className="w-3.5 h-3.5 text-[hsl(var(--warning))]" />
                  : <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground" />}
                <span className="text-foreground/80 truncate">{t.kind === "reward" ? "Block Reward" : (t.from === "coinbase" ? "blob" : shortHash(t.from, 6))}</span>
                <span className="hidden sm:block text-foreground/80 truncate">{t || shortHash(t.to, 6)}</span>
                <span className="num text-primary/80">{t.amount} BLOB</span>
                <span className="num text-muted-foreground">{t.status === "pending" ? "—" : `#${t.block}`}</span>
                <span className={`num text-right ${t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-muted-foreground"}`}>
                  {t.status === "pending" ? "pending" : timeAgo(t.timestamp)}
                </span>
              </div>
              {selTx === t.id && (
                <div className="glass-hi mt-1 p-3 text-xs space-y-1.5 overflow-x-auto">
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">ID</span><span className="num text-foreground/70 break-all">{t.id}</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="label-eyebrow">From</span>
                    <button onClick={() => { setTab("addresses"); setSelAddr(t.from); }} className="num text-[hsl(var(--warning))] hover:underline text-left break-all">
                      {t.kind === "reward" ? "Block Reward" : (t.from === "coinbase" ? "blob" : t.from)}
                    </button>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2">
                    <span className="label-eyebrow">To</span>
                    <button onClick={() => { setTab("addresses"); setSelAddr(t.to); }} className="num text-[hsl(var(--warning))] hover:underline text-left break-all">{t.to}</button>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Amount</span><span className="num">{t.amount} BLOB</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Fee</span><span className="num">{t.fee} BLOB</span></div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Status</span>
                    <span className={t.status === "pending" ? "text-[hsl(var(--warning))]" : "text-foreground/70"}>
                      {t.status === "pending" ? "⧗ pending in mempool" : `✓ confirmed in block #${t.block}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Time</span><span>{new Date(t.timestamp).toLocaleString()}</span></div>
                  {t.signature && (
                    <div className="grid grid-cols-[80px_1fr] gap-2"><span className="label-eyebrow">Signature</span><span className="num text-foreground/60 break-all text-[10px]">{t.signature}</span></div>
                  )}
                </div>
              )}
            </div>
          ))}
          <Pager page={pTxs} setPage={setPTxs} total={txsFiltered.length} label="transactions" />
        </div>
      )}

      {tab === "mempool" && (
        <MempoolView
          mempool={mempool}
          chain={chain}
          blockInfo={blockInfo}
          memF={memF}
          setMemF={setMemF}
          pMem={pMem}
          setPMem={setPMem}
          onSelectTx={(id) => { setTab("txs"); setSelTx(id); }}
          onSelectBlock={(h) => { setTab("blocks"); setSelBlock(h); }}
        />
      )}

      {tab === "addresses" && (
        <div className="space-y-1.5">
          {selAddr ? (
            (() => {
              const a = addressBook.find(x => x.address === selAddr);
              const addrTxs = [...memTxs, ...allTxs].filter(t => t.from === selAddr || t.to === selAddr);
              const balance = (a?.received || 0) + (a?.mined || 0) - (a?.sent || 0);
              return (
                <div className="space-y-3">
                  <button onClick={() => setSelAddr(null)} className="text-xs text-muted-foreground hover:text-foreground">← Back to addresses</button>
                  <div className="glass-hi p-4 space-y-2">
                    <div className="label-eyebrow">Address</div>
                    <div className="num text-sm text-foreground/90 break-all">{selAddr}</div>
                    
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <ExplorerStat label="Balance" value={`${balance.toFixed(4)}`} sub="BLOB" />
                    <ExplorerStat label="Mined" value={(a?.mined || 0).toFixed(2)} sub="from blocks" />
                    <ExplorerStat label="Received" value={(a?.received || 0).toFixed(2)} />
                    <ExplorerStat label="Sent" value={(a?.sent || 0).toFixed(2)} />
                  </div>
                  <div className="label-eyebrow px-1">Transactions ({addrTxs.length})</div>
                  {addrTxs.slice(0, 50).map(t => (
                    <button key={t.id} onClick={() => { setTab("txs"); setSelTx(t.id); }}
                      className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition flex items-center justify-between gap-2 text-xs">
                      {t.kind === "reward"
                        ? <HandCoins className="w-3.5 h-3.5 text-[hsl(var(--warning))] shrink-0" />
                        : t.from === selAddr
                          ? <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          : <ArrowDownLeft className="w-3.5 h-3.5 text-primary/80 shrink-0" />}
                      <span className="text-foreground/70 truncate flex-1">
                        {t.from === selAddr ? `→ ${shortHash(t.to, 8)}` : `← ${t.kind === "reward" ? "Block Reward" : (t.from === "coinbase" ? "blob" : shortHash(t.from, 8))}`}
                      </span>
                      <span className={`num shrink-0 ${t.from === selAddr ? "text-muted-foreground" : "text-primary/80"}`}>
                        {t.from === selAddr ? "-" : "+"}{t.amount} BLOB
                      </span>
                      <span className="num text-muted-foreground shrink-0 text-[10px]">{t.status === "pending" ? "pending" : `#${t.block}`}</span>
                    </button>
                  ))}
                </div>
              );
            })()
          ) : (
            <>
              <FilterPanel activeCount={addrFiltersActive(addrF)} onClear={() => setAddrF(emptyAddrFilters)}>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  <div className="col-span-2">
                    <FieldLabel>Address</FieldLabel>
                    <FInput value={addrF.q} onChange={e => setAddrF({ ...addrF, q: e.target.value })} placeholder="search…" />
                  </div>
                  <div>
                    <FieldLabel>Min balance BLOB</FieldLabel>
                    <FInput type="number" value={addrF.minBalance} onChange={e => setAddrF({ ...addrF, minBalance: e.target.value })} placeholder="0" />
                  </div>
                  <div>
                    <FieldLabel>Has mined</FieldLabel>
                    <FSelect value={addrF.hasMined} onChange={v => setAddrF({ ...addrF, hasMined: v as any })}
                      options={[{ v: "all", l: "Any" }, { v: "yes", l: "Miners only" }, { v: "no", l: "Non-miners" }]} />
                  </div>
                  <div>
                    <FieldLabel>Has transactions</FieldLabel>
                    <FSelect value={addrF.hasTxs} onChange={v => setAddrF({ ...addrF, hasTxs: v as any })}
                      options={[{ v: "all", l: "Any" }, { v: "yes", l: "Active" }, { v: "no", l: "Idle" }]} />
                  </div>
                  <div>
                    <FieldLabel>Sort by</FieldLabel>
                    <FSelect value={addrF.sort} onChange={v => setAddrF({ ...addrF, sort: v as any })}
                      options={[
                        { v: "balance-desc", l: "Highest balance" },
                        { v: "balance-asc", l: "Lowest balance" },
                        { v: "mined-desc", l: "Most mined" },
                        { v: "tx-desc", l: "Most active" },
                        { v: "recent", l: "Recently seen" },
                        
                      ]} />
                  </div>
                </div>
              </FilterPanel>
              <div className="flex items-center justify-between px-1 text-[10px] text-muted-foreground num">
                <span>{addrFiltered.length} of {addressBook.length} addresses</span>
              </div>
              <div className="grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto_60px] gap-3 px-3 py-1">
                {(window.innerWidth < 640 ? ["Address", "Balance / Mined"] : ["Address", "Balance", "Mined", "Tx"]).map(h => <div key={h} className="label-eyebrow">{h}</div>)}
              </div>
              {addressBook.length === 0 ? (
                <div className="glass text-center py-10 text-xs text-muted-foreground">No addresses tracked yet</div>
              ) : addrFiltered.length === 0 && (
                <div className="glass text-center py-10 text-xs text-muted-foreground">No addresses match these filters</div>
              )}
              {addrFiltered.slice(pAddr * PAGE_SIZE, (pAddr + 1) * PAGE_SIZE).map(a => {
                const balance = a.received + a.mined - a.sent;
                return (
                  <button key={a.address} onClick={() => setSelAddr(a.address)}
                    className="w-full text-left glass px-3 py-2.5 hover:bg-secondary/30 transition grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_auto_auto_60px] gap-3 items-center text-xs">
                    <div className="min-w-0">
                      <div className="num text-foreground/80 truncate">{shortHash(a.address, 8)}</div>
                      
                    </div>
                    <div className="text-right">
                      <div className="num text-primary/80 whitespace-nowrap">{balance.toFixed(8)} BLOB</div>
                      <div className="num text-[10px] text-muted-foreground whitespace-nowrap sm:hidden">mined {a.mined.toFixed(8)}</div>
                    </div>
                    <span className="hidden sm:block num text-muted-foreground text-right whitespace-nowrap">{a.mined.toFixed(8)}</span>
                    <span className="hidden sm:block num text-right text-muted-foreground">{a.txCount}</span>
                  </button>
                );
              })}
              <Pager page={pAddr} setPage={setPAddr} total={addrFiltered.length} label="addresses" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
