import { memo } from "react";
import { Play, Lock } from "lucide-react";
import { ENTRY_REVEAL_WINDOW_SECONDS } from "@/lib/blob/entryPow";

function MineHero({ blockInfo, blockTime, entries = [], onLaunch }: any) {
  const remaining = blockTime?.remaining ?? blockInfo.remaining ?? 0;
  const overdue = !!(blockTime?.overdue ?? blockInfo.overdue);
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const time = m > 0 ? `${m}m ${s}s` : `${s}s`;

<<<<<<< HEAD
  // Mirror the node's validateEntry exactly (Phase 6):
  //   - commit phase (remaining > 30): always open
  //   - cutoff window (0 < remaining <= 30): always closed
  //   - overdue (remaining = 0 / overdue):
  //       * no entries yet -> "overdue grace", node still accepts entries, so
  //         the gate stays open. This is the path that lets the chain
  //         self-heal when a window passes with zero participation.
  //       * any entries -> gate closes, the block will seal next tick.
  const entryCount = entries.length;
  const inOverdueGrace = overdue && entryCount === 0;
  const commitClosed = remaining <= ENTRY_REVEAL_WINDOW_SECONDS && !inOverdueGrace;
=======
  // Commit phase ends ENTRY_REVEAL_WINDOW_SECONDS before block close. We
  // refuse to launch new runs once we're inside the reveal window because
  // their commits would be rejected by the node anyway (validateEntryCommit
  // returns "commit window closed"). Gating here means the user never burns
  // a run that can't be submitted.
  //
  // Note: this only blocks *starting* a run. Runs already in progress when
  // the commit phase ends finish naturally — the in-progress submission
  // path is unchanged. They'll fail at the node, and that's expected
  // protocol behaviour.
  const commitClosed = remaining <= ENTRY_REVEAL_WINDOW_SECONDS;
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

  return (
    <div className="relative overflow-hidden rounded-3xl glass-pane px-6 py-12 sm:py-16 text-center">
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[480px] h-[480px] rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 right-0 w-[360px] h-[360px] rounded-full bg-accent/10 blur-3xl" />
      <div className="relative">
        <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight mb-3">
          <span className="text-foreground">MINE </span>
          <span className="text-brand-gradient drop-shadow-[0_0_24px_hsl(var(--accent)/0.4)]">BLOB</span>
        </h1>
        <div className="text-xs sm:text-sm text-muted-foreground mb-8 num">
          Block #{blockInfo.height} · Reward: {blockInfo.reward} BLOB · Level seed #{blockInfo.seed}
        </div>
        <div className={`text-4xl sm:text-5xl font-light mb-6 num ${commitClosed ? "text-destructive/80" : "text-primary/90"}`}>
          {time} remaining
        </div>
        <div className="inline-flex items-center gap-3 px-5 py-2 rounded-full border border-border/50 bg-card/40 text-[10px] sm:text-xs tracking-[0.18em] text-muted-foreground uppercase mb-3 num">
          <span>Space / Jump</span>
          <span className="text-border">·</span>
          <span>↓ Duck</span>
          <span className="text-border">·</span>
          <span>Ƀ +50 Pts</span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 mb-8">
          Higher score = higher probability of winning block reward
        </div>
        {commitClosed ? (
          <div className="inline-flex flex-col items-center gap-2">
            <button
              type="button"
              disabled
              aria-disabled="true"
              className="group relative inline-flex items-center gap-2 px-10 py-4 rounded-full bg-muted/20 border border-border/40 text-muted-foreground/70 font-semibold tracking-wide text-sm sm:text-base cursor-not-allowed opacity-70"
            >
              <Lock className="w-4 h-4" />
              COMMIT PHASE ENDED
            </button>
            <div className="text-[10px] tracking-[0.2em] text-muted-foreground/60 uppercase mt-1">
              New entries reopen for block #{blockInfo.height + 1} in {time}
            </div>
          </div>
        ) : (
          <button
            onClick={onLaunch}
            className="group relative inline-flex items-center gap-2 px-10 py-4 rounded-full bg-primary/10 border border-primary/40 text-primary font-semibold tracking-wide text-sm sm:text-base hover:bg-primary/20 hover:ring-1 hover:ring-accent/50 transition-all shadow-[0_0_40px_hsl(var(--primary)/0.35)] hover:shadow-[0_0_60px_hsl(var(--accent)/0.45)]"
          >
            <Play className="w-4 h-4 fill-primary" />
            LAUNCH BLOB RUN
          </button>
        )}
      </div>
    </div>
  );
}

export default memo(MineHero);