import { memo } from "react";
import { calcTotalSupply, winProbability } from "@/lib/blob/chain";
import { MAX_SUPPLY } from "@/lib/blob/constants";
import runnerArt from "@/assets/blob-coins-stack.png";

function MiningPanel({ blockInfo, blockTime, entries, myEntry, chain }: any) {
  // Revealed entries sort by score desc; pending (commit-only) entries are
  // shown after revealed ones with their score hidden until they reveal.
  const revealed = entries.filter((e: any) => !e.pending).sort((a: any, b: any) => b.score - a.score);
  const pending = entries.filter((e: any) => e.pending);
  const sorted = [...revealed, ...pending];
  const total = revealed.reduce((s: number, e: any) => s + e.score, 0);
  const supplyNow = calcTotalSupply(chain);
  const supplyPct = Math.min((supplyNow / MAX_SUPPLY) * 100, 100);

  const Stat = ({ label, value, accent }: any) => (
    <div className="px-1">
      <div className="label-eyebrow mb-2">{label}</div>
      <div className={`text-2xl sm:text-3xl font-semibold num ${accent || "text-foreground"}`}>{value}</div>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-1">
        <Stat label="Block" value={`#${blockInfo.height}`} accent="text-primary" />
        <Stat label="Reward" value={`${blockInfo.reward} BLOB`} />
        <Stat
          label={blockInfo.awaitingMiner ? "Awaiting" : "Remaining"}
          value={blockInfo.awaitingMiner ? "miner" : `${blockTime?.remaining ?? blockInfo.remaining ?? 0}s`}
          accent={blockInfo.awaitingMiner ? "text-[hsl(var(--warning))]" : "text-primary"}
        />
        <Stat label="Miners" value={entries.length} />
      </div>

      <div className="glass px-5 py-4">
        <div className="flex items-center justify-between mb-3 text-xs">
          <span className="font-medium tracking-wide">BLOB SUPPLY</span>
          <span className="text-muted-foreground num">
            {supplyNow.toFixed(2)} / {MAX_SUPPLY.toLocaleString()} ({supplyPct.toFixed(5)}%)
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-accent transition-all duration-500 shadow-[0_0_12px_hsl(var(--primary)/0.6)]"
            style={{ width: `${supplyPct}%` }}
          />
        </div>
      </div>

      <div>
        {entries.length === 0 ? (
          <div className="relative glass overflow-hidden">
            <div className="px-6 py-10 sm:py-14 flex items-center min-h-[160px]">
              <div className="text-base sm:text-lg text-foreground/80 max-w-[60%] leading-relaxed">
                No entries yet — play Blob Run to submit yours
              </div>
            </div>
            <img
              src={runnerArt}
              alt=""
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-40 sm:w-48 opacity-70"
              loading="lazy"
              width={512}
              height={512}
            />
          </div>
        ) : (
          <>
            <div className="label-eyebrow mb-3 px-1">Current block entries</div>
            <div className="space-y-1.5">
              {sorted.map((e: any, i: number) => {
                const pct = total > 0 ? +((e.score / total) * 100).toFixed(1) : 0;
                const isMe = e.address === myEntry?.address;
                return (
                  <div
                    key={e.address + i}
                    className={`glass px-4 py-3 flex items-center gap-3 ${isMe ? "ring-1 ring-primary/40" : ""}`}
                  >
                    <span className="w-6 text-sm">
                      {i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : <span className="text-muted-foreground">{i + 1}</span>}
                    </span>
                    <span className={`flex-1 text-sm truncate ${isMe ? "text-primary" : "text-foreground/80"}`}>
                      {e.address?.slice(0, 14)}
                    </span>
                    <span className="num text-sm font-medium">{e.score.toLocaleString()}</span>
                    <div className="w-24 h-1 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={`h-full ${isMe ? "bg-primary" : i === 0 ? "bg-[hsl(var(--warning))]" : "bg-muted-foreground"}`}
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <span className="num text-xs w-12 text-right text-muted-foreground">{pct}%</span>
                  </div>
                );
              })}
            </div>
            {myEntry && (
              <div className="mt-3 text-xs text-center text-muted-foreground">
                Your win probability: <span className="text-primary num">{winProbability(myEntry.score, entries)}%</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default memo(MiningPanel);
