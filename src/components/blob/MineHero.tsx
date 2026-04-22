// @ts-nocheck
import { Play } from "lucide-react";

export default function MineHero({ blockInfo, onLaunch }: any) {
  const m = Math.floor(blockInfo.remaining / 60);
  const s = blockInfo.remaining % 60;
  const time = m > 0 ? `${m}m ${s}s` : `${s}s`;
  return (
    <div className="relative overflow-hidden rounded-3xl glass-hi px-6 py-12 sm:py-16 text-center">
      <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[480px] h-[480px] rounded-full bg-primary/10 blur-3xl" />
      <div className="relative">
        <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight mb-3">
          <span className="text-foreground">MINE </span>
          <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">$BLOB</span>
        </h1>
        <div className="text-xs sm:text-sm text-muted-foreground mb-8 num">
          Block #{blockInfo.height} · Reward: {blockInfo.reward} $BLOB · Level seed #{blockInfo.seed}
        </div>
        <div className="text-4xl sm:text-5xl font-light text-primary/90 mb-6 num">
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
        <button
          onClick={onLaunch}
          className="group relative inline-flex items-center gap-2 px-10 py-4 rounded-full bg-primary/10 border border-primary/40 text-primary font-semibold tracking-wide text-sm sm:text-base hover:bg-primary/20 transition-all shadow-[0_0_40px_hsl(var(--primary)/0.35)] hover:shadow-[0_0_60px_hsl(var(--primary)/0.55)]"
        >
          <Play className="w-4 h-4 fill-primary" />
          LAUNCH BLOB RUN
        </button>
      </div>
    </div>
  );
}
