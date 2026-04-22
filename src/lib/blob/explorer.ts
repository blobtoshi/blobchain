// @ts-nocheck
// Pure helpers + types for the BlockExplorer view.

export type ExplorerTx = {
  id: string;
  from: string;
  to: string;
  fromUsername?: string;
  toUsername?: string;
  amount: number;
  fee: number;
  feeRate?: number;
  memo?: string;
  timestamp: number;
  status: "confirmed" | "pending";
  block?: number;
  signature?: string;
  kind: "transfer" | "reward";
};

export function flattenChainTxs(chain: any[]): ExplorerTx[] {
  const out: ExplorerTx[] = [];
  for (const b of chain) {
    if (b.winner && b.reward > 0) {
      out.push({
        id: `reward-${b.height}`,
        from: "coinbase",
        to: b.winner,
        toUsername: b.winnerUsername,
        amount: Number(b.reward),
        fee: 0,
        timestamp: b.timestamp,
        status: "confirmed",
        block: b.height,
        kind: "reward",
      });
    }
    for (const tx of (b.transactions || [])) {
      out.push({
        id: tx.id || `${b.height}-${tx.signature?.slice(0, 12)}`,
        from: tx.from,
        to: tx.to,
        fromUsername: tx.fromUsername,
        toUsername: tx.toUsername,
        amount: Number(tx.amount),
        fee: Number(tx.fee || 0),
        feeRate: tx.feeRate != null ? Number(tx.feeRate) : undefined,
        memo: tx.memo || "",
        timestamp: tx.timestamp || b.timestamp,
        status: "confirmed",
        block: b.height,
        signature: tx.signature,
        kind: "transfer",
      });
    }
  }
  return out.sort((a, b) => b.timestamp - a.timestamp);
}

export function mempoolToTxs(mempool: any[]): ExplorerTx[] {
  return mempool.map((tx: any) => ({
    id: tx.id,
    from: tx.from,
    to: tx.to,
    fromUsername: tx.fromUsername,
    amount: Number(tx.amount),
    fee: Number(tx.fee || 0),
    feeRate: tx.feeRate != null ? Number(tx.feeRate) : undefined,
    memo: tx.memo || "",
    timestamp: tx.timestamp,
    status: "pending" as const,
    signature: tx.signature,
    kind: "transfer" as const,
  }));
}

export function shortHash(s?: string, n = 8) {
  if (!s) return "—";
  if (s.length <= n * 2 + 1) return s;
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

export function timeAgo(ts: number) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------- Filters ----------
export type TxFilters = {
  addr: string;
  addrSide: "any" | "from" | "to";
  minAmount: string;
  maxAmount: string;
  dateFrom: string;
  dateTo: string;
  status: "all" | "confirmed" | "pending";
  kind: "all" | "transfer" | "reward";
  sort: "newest" | "oldest" | "amount-desc" | "amount-asc";
};
export const emptyTxFilters: TxFilters = {
  addr: "", addrSide: "any", minAmount: "", maxAmount: "",
  dateFrom: "", dateTo: "", status: "all", kind: "all", sort: "newest",
};

export type BlockFilters = {
  winner: string;
  minHeight: string;
  maxHeight: string;
  dateFrom: string;
  dateTo: string;
  hasTxs: "all" | "yes" | "no";
  sort: "newest" | "oldest" | "reward-desc" | "score-desc";
};
export const emptyBlockFilters: BlockFilters = {
  winner: "", minHeight: "", maxHeight: "", dateFrom: "", dateTo: "", hasTxs: "all", sort: "newest",
};

export type AddrFilters = {
  q: string;
  minBalance: string;
  hasMined: "all" | "yes" | "no";
  hasTxs: "all" | "yes" | "no";
  sort: "balance-desc" | "balance-asc" | "mined-desc" | "tx-desc" | "recent" | "username";
};
export const emptyAddrFilters: AddrFilters = {
  q: "", minBalance: "", hasMined: "all", hasTxs: "all", sort: "balance-desc",
};

export function dateToTs(d: string, end = false): number | null {
  if (!d) return null;
  const t = new Date(d + (end ? "T23:59:59.999" : "T00:00:00")).getTime();
  return Number.isFinite(t) ? t : null;
}

export function applyTxFilters(list: ExplorerTx[], f: TxFilters): ExplorerTx[] {
  const addr = f.addr.trim().toLowerCase();
  const min = f.minAmount === "" ? null : Number(f.minAmount);
  const max = f.maxAmount === "" ? null : Number(f.maxAmount);
  const from = dateToTs(f.dateFrom);
  const to = dateToTs(f.dateTo, true);
  const matchAddr = (val?: string, uname?: string) =>
    !!val && (val.toLowerCase().includes(addr) || (uname || "").toLowerCase().includes(addr));
  const out = list.filter(t => {
    if (f.kind !== "all" && t.kind !== f.kind) return false;
    if (f.status !== "all" && t.status !== f.status) return false;
    if (min !== null && t.amount < min) return false;
    if (max !== null && t.amount > max) return false;
    if (from !== null && t.timestamp < from) return false;
    if (to !== null && t.timestamp > to) return false;
    if (addr) {
      const inFrom = matchAddr(t.from, t.fromUsername);
      const inTo = matchAddr(t.to, t.toUsername);
      if (f.addrSide === "from" && !inFrom) return false;
      if (f.addrSide === "to" && !inTo) return false;
      if (f.addrSide === "any" && !inFrom && !inTo) return false;
    }
    return true;
  });
  switch (f.sort) {
    case "oldest": out.sort((a, b) => a.timestamp - b.timestamp); break;
    case "amount-desc": out.sort((a, b) => b.amount - a.amount); break;
    case "amount-asc": out.sort((a, b) => a.amount - b.amount); break;
    default: out.sort((a, b) => b.timestamp - a.timestamp);
  }
  return out;
}

export function txFiltersActive(f: TxFilters): number {
  let n = 0;
  if (f.addr) n++;
  if (f.minAmount) n++;
  if (f.maxAmount) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.status !== "all") n++;
  if (f.kind !== "all") n++;
  if (f.sort !== "newest") n++;
  return n;
}
export function blockFiltersActive(f: BlockFilters): number {
  let n = 0;
  if (f.winner) n++;
  if (f.minHeight) n++;
  if (f.maxHeight) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  if (f.hasTxs !== "all") n++;
  if (f.sort !== "newest") n++;
  return n;
}
export function addrFiltersActive(f: AddrFilters): number {
  let n = 0;
  if (f.q) n++;
  if (f.minBalance) n++;
  if (f.hasMined !== "all") n++;
  if (f.hasTxs !== "all") n++;
  if (f.sort !== "balance-desc") n++;
  return n;
}
