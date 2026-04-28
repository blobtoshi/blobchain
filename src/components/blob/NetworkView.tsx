import { useEffect, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import { calcTotalSupply } from "@/lib/blob/chain";
import { memoBytes } from "@/lib/blob/fees";
import {
  BLOCK_TIME, MAX_SUPPLY, MAX_BLOCK_SIZE, HALVING_BLOCKS, BASE_FEE_RATE, MIN_FEE_RATE,
  BLOB_DECIMALS, MAX_MEMO_BYTES, BRIDGE_ADDRESS,
} from "@/lib/blob/constants";
import blobCoin from "@/assets/blob-coin.png";

export default function NetworkView({ nodeCount, chain, blockInfo, mempool = [] }: any) {
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const info = await Relay.fetchFeeInfo();
      if (!cancelled && info) setFeeInfo(info);
    };
    load();
    const id = setInterval(load, 15_000);
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => { cancelled = true; clearInterval(id); clearInterval(t); };
  }, []);

  const supply = calcTotalSupply(chain);
  const supplyPct = Math.min((supply / MAX_SUPPLY) * 100, 100);
  const totalTxs = chain.reduce((s: number, b: any) => s + (b.transactions || []).length, 0);
  const height = Math.max(0, chain.length - 1);

  const halvingsDone = Math.floor(height / HALVING_BLOCKS);
  const blocksToNextHalving = HALVING_BLOCKS - (height % HALVING_BLOCKS);
  const secondsToNextHalving = blocksToNextHalving * BLOCK_TIME;
  const nextHalvingDate = new Date(Date.now() + secondsToNextHalving * 1000);
  const nextReward = blockInfo.reward / 2;

  const remaining = blockInfo.remaining;
  const elapsedPct = Math.min(100, (blockInfo.elapsed / BLOCK_TIME) * 100);
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  const mpBytes = mempool.reduce((s: number, t: any) => {
    const sigLen = (t.signature || "").length || 128;
    const memoLen = memoBytes(t.memo || "");
    return s + 220 + sigLen + memoLen;
  }, 0);
  const load = Math.min(1, mpBytes / MAX_BLOCK_SIZE);
  const baseRate = feeInfo?.baseFeeRate ?? BASE_FEE_RATE;
  const recRate = feeInfo?.recommendedFeeRate ?? baseRate;
  const minRate = feeInfo?.minFeeRate ?? MIN_FEE_RATE;
  const congestionPct = Math.round(load * 100);
  const difficultyMult = recRate / baseRate;
  let congestionLabel = "Idle";
  let congestionTone = "text-[hsl(var(--info))]";
  if (load >= 0.66) { congestionLabel = "Congested"; congestionTone = "text-[hsl(var(--danger))]"; }
  else if (load >= 0.25) { congestionLabel = "Busy"; congestionTone = "text-[hsl(var(--warning))]"; }
  else if (load > 0) { congestionLabel = "Light"; congestionTone = "text-primary"; }

  const recent = chain.slice(-10).reverse();
  const minedRecent = recent.filter((b: any) => b.winner).length;
  const fillRate = recent.length ? Math.round((minedRecent / recent.length) * 100) : 0;
  const avgTxsPerBlock = recent.length ? (recent.reduce((s: number, b: any) => s + (b.transactions || []).length, 0) / recent.length) : 0;

  const Stat = ({ label, value, sub, tone = "text-foreground" }: any) => (
    <div className="glass p-4 rounded-md">
      <div className="label-eyebrow">{label}</div>
      <div className={`num text-xl font-semibold mt-1.5 leading-tight ${tone}`}>{value}</div>
      {sub && <div className="text-[11px] text-foreground/50 mt-1 num">{sub}</div>}
    </div>
  );

  const Bar = ({ pct, tone = "bg-primary" }: { pct: number; tone?: string }) => (
    <div className="h-1.5 w-full bg-foreground/10 rounded-full overflow-hidden">
      <div className={`h-full ${tone} transition-all duration-700`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );

  const Row = ({ k, v, tone = "text-foreground" }: any) => (
    <div className="flex items-center justify-between text-sm py-1.5 border-b border-foreground/5 last:border-0">
      <span className="text-foreground/60">{k}</span>
      <span className={`num font-medium ${tone}`}>{v}</span>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between gap-4 pb-1">
        <div>
          <div className="label-eyebrow text-primary">BLOB Network</div>
          <div className="text-2xl font-semibold tracking-tight mt-1">Live network state</div>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-foreground/60">
          <a
            href="https://github.com/blobchain/blobchain/blob/main/node/README.md"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:inline text-foreground/70 hover:text-foreground transition-colors"
            title="Run your own full node"
          >
            Run a node →
          </a>
          <span className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            ONLINE · {nodeCount} {nodeCount === 1 ? "node" : "nodes"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Chain height" value={height.toLocaleString()} sub={`${totalTxs} confirmed txs`} tone="text-primary" />
        <Stat label="Block reward" value={`${blockInfo.reward} BLOB`} sub={`Halving #${halvingsDone + 1} → ${nextReward} BLOB`} tone="text-[hsl(var(--warning))]" />
        <Stat label="Active nodes" value={nodeCount} sub="full validating" tone="text-[hsl(var(--info))]" />
        <Stat label="Mempool" value={mempool.length} sub={`${(mpBytes / 1024).toFixed(2)} KB queued`} tone={congestionTone} />
      </div>

      <div className={`glass p-5 rounded-md ${blockInfo.awaitingMiner ? "ring-1 ring-[hsl(var(--warning)/0.4)]" : ""}`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="label-eyebrow">{blockInfo.awaitingMiner ? "Awaiting miner" : "Next block"}</div>
            <div className="text-sm text-foreground/60 mt-0.5">Block #{blockInfo.height} · {BLOCK_TIME}s target</div>
          </div>
          {blockInfo.awaitingMiner ? (
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[hsl(var(--warning))] opacity-70" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-[hsl(var(--warning))]" />
              </span>
              <div className="num text-xl font-semibold tabular-nums tracking-tight text-[hsl(var(--warning))]">
                +{Math.floor(blockInfo.overtime / 60).toString().padStart(2, "0")}:{(blockInfo.overtime % 60).toString().padStart(2, "0")}
              </div>
            </div>
          ) : (
            <div className="num text-3xl font-semibold tabular-nums tracking-tight text-primary">{mm}:{ss}</div>
          )}
        </div>
        <Bar pct={blockInfo.awaitingMiner ? 100 : elapsedPct} tone={blockInfo.awaitingMiner ? "bg-[hsl(var(--warning))]" : "bg-primary"} />
        <div className="flex justify-between text-[11px] text-foreground/50 mt-1.5 num">
          <span>{blockInfo.elapsed}s elapsed</span>
          <span>{blockInfo.awaitingMiner ? "needs ≥1 miner to seal" : `${remaining}s remaining`}</span>
        </div>
      </div>

      <div className="glass p-5 rounded-md">
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="label-eyebrow">Network difficulty</div>
            <div className="text-sm text-foreground/60 mt-0.5">Gas pricing reflects mempool congestion</div>
          </div>
          <div className="text-right">
            <div className={`text-xs font-semibold uppercase tracking-wider ${congestionTone}`}>{congestionLabel}</div>
            <div className="num text-[11px] text-foreground/50 mt-0.5">{congestionPct}% load</div>
          </div>
        </div>
        <Bar pct={congestionPct} tone={load >= 0.66 ? "bg-[hsl(var(--danger))]" : load >= 0.25 ? "bg-[hsl(var(--warning))]" : "bg-primary"} />
        <div className="grid grid-cols-3 gap-2 mt-4">
          <div className="rounded-md border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/50">Slow</div>
            <div className="num text-sm font-semibold mt-1">{Math.max(minRate, Math.floor(recRate * 0.5))} <span className="text-[10px] text-foreground/50 font-normal">drops/B</span></div>
          </div>
          <div className="rounded-md border border-primary/30 bg-primary/[0.06] p-3">
            <div className="text-[10px] uppercase tracking-wider text-primary">Normal</div>
            <div className="num text-sm font-semibold mt-1 text-primary">{recRate} <span className="text-[10px] text-foreground/50 font-normal">drops/B</span></div>
          </div>
          <div className="rounded-md border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[10px] uppercase tracking-wider text-foreground/50">Fast</div>
            <div className="num text-sm font-semibold mt-1">{Math.max(minRate, Math.ceil(recRate * 2))} <span className="text-[10px] text-foreground/50 font-normal">drops/B</span></div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-foreground/5">
          <Row k="Difficulty multiplier" v={`${difficultyMult.toFixed(2)}×`} tone={difficultyMult > 1 ? "text-[hsl(var(--warning))]" : "text-foreground"} />
          <Row k="Base fee rate" v={`${baseRate} drops/B`} />
          <Row k="Min fee rate (floor)" v={`${minRate} drops/B`} />
          <Row k="Max block size" v={`${(MAX_BLOCK_SIZE / 1000).toFixed(0)} KB`} />
        </div>
      </div>

      <div className="glass p-5 rounded-md">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2.5">
            <img src={blobCoin} alt="BLOB coin" className="w-8 h-8 object-contain" />
            <div>
              <div className="text-sm font-semibold tracking-tight">BLOB</div>
              <div className="text-[11px] text-foreground/50">Native asset · Proof-of-Gaming</div>
            </div>
          </div>
          <div className="text-right">
            <div className="num text-sm font-semibold">{supply.toFixed(2)}</div>
            <div className="text-[10px] text-foreground/50 num">/ {MAX_SUPPLY.toLocaleString()} max</div>
          </div>
        </div>
        <Bar pct={supplyPct} tone="bg-gradient-to-r from-primary to-[hsl(var(--info))]" />
        <div className="text-[11px] text-foreground/50 num mt-1.5">{supplyPct.toFixed(5)}% of max supply mined</div>
        <div className="mt-4 pt-4 border-t border-foreground/5">
          <Row k="Divisibility" v={`${BLOB_DECIMALS} decimals`} />
          <Row k="Base unit" v="1 drop = 0.00000001 BLOB" />
          <Row k="Halving schedule" v={`Every ${HALVING_BLOCKS.toLocaleString()} blocks`} />
          <Row k="Halvings completed" v={halvingsDone} />
          <Row k="Blocks to next halving" v={blocksToNextHalving.toLocaleString()} />
          <Row k="Est. next halving" v={nextHalvingDate.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} tone="text-[hsl(var(--info))]" />
        </div>
      </div>

      <div className="glass p-5 rounded-md">
        <div className="label-eyebrow mb-3">Recent activity (last 10 blocks)</div>
        <div className="grid grid-cols-2 gap-2 mb-4">
          <Stat label="Block fill rate" value={`${fillRate}%`} sub={`${minedRecent}/${recent.length} mined`} tone={fillRate >= 70 ? "text-primary" : "text-[hsl(var(--warning))]"} />
          <Stat label="Avg txs/block" value={avgTxsPerBlock.toFixed(1)} sub="confirmed" />
        </div>
        <div className="flex items-end gap-1 h-12">
          {recent.slice().reverse().map((b: any, i: number) => {
            const txs = (b.transactions || []).length;
            const h = b.winner ? Math.max(20, Math.min(100, 35 + txs * 12)) : 8;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className={`w-full rounded-sm transition-all ${b.winner ? "bg-primary/70" : "bg-foreground/10"}`}
                  style={{ height: `${h}%` }}
                  title={`#${b.height} · ${txs} tx${b.winner ? ` · won by ${"?"}` : " · empty"}`}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="glass p-5 rounded-md">
        <div className="label-eyebrow mb-3">Consensus</div>
        <Row k="Algorithm" v="Proof-of-Gaming" tone="text-primary" />
        <Row k="Block time" v={`${BLOCK_TIME}s`} />
        <Row k="Winner selection" v="Weighted lottery" />
        <Row k="Score proof" v="ECDSA P-256" />
        <Row k="Tx fee model" v="drops/byte × tx size" />
        <Row k="Memo limit" v={`${MAX_MEMO_BYTES} bytes`} />
        <Row k="🔒 Bridge address" v={BRIDGE_ADDRESS} tone="text-primary" />
      </div>
    </div>
  );
}
