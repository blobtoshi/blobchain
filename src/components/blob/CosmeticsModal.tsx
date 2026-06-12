import { useEffect, useState } from "react";
import { X, Check } from "lucide-react";
import { BACKGROUNDS } from "@/lib/blob/backgrounds";
import { SKINS } from "@/lib/blob/skins";
import { OBSTACLE_STYLES } from "@/lib/blob/obstacleStyles";
import {
  getCosmetics, setCosmetic, subscribeCosmetics,
  type CosmeticCategory,
} from "@/lib/blob/cosmetics";

// Cosmetics picker. Three tabs: skin / background / obstacles. Each option
// renders as a tile with a quick description; clicking selects it and the
// game loop picks up the change on the next frame via the subscribeCosmetics
// listener it set up on mount.
//
// Selections are pure visuals - no wallet, no signing, no on-chain - so a
// click instantly applies. localStorage persistence is handled inside the
// cosmetics module.

type Props = {
  open: boolean;
  onClose: () => void;
};

const TABS: { key: CosmeticCategory; label: string }[] = [
  { key: "skin",       label: "Skin"        },
  { key: "background", label: "Background"  },
  { key: "obstacles",  label: "Obstacles"   },
];

export default function CosmeticsModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<CosmeticCategory>("background");
  const [current, setCurrent] = useState(getCosmetics());

  // Keep local state in sync with the cosmetics store. The store can be
  // mutated from anywhere (us, the game loop in theory, future code), so
  // we subscribe rather than treating this component as the sole writer.
  useEffect(() => {
    return subscribeCosmetics(setCurrent);
  }, []);

  // Close on Escape - standard modal affordance.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const options = tab === "skin" ? SKINS
                : tab === "background" ? BACKGROUNDS
                : OBSTACLE_STYLES;
  const selectedId = current[tab];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/85 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="glass-pane w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border/40">
          <div>
            <div className="label-eyebrow">Cosmetics</div>
            <div className="text-lg font-semibold tracking-tight">Customize your run</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="p-2 rounded-full hover:bg-muted/30 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex gap-1 p-2 border-b border-border/40">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-full text-[11px] tracking-[0.2em] uppercase transition ${
                tab === t.key
                  ? "bg-primary text-primary-foreground shadow-[0_0_18px_hsl(var(--primary)/0.4)]"
                  : "text-muted-foreground hover:bg-muted/30"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {options.map((opt) => {
            const isSelected = opt.id === selectedId;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setCosmetic(tab, opt.id)}
                className={`text-left p-4 rounded-lg border transition relative ${
                  isSelected
                    ? "border-primary/60 bg-primary/10 shadow-[0_0_24px_hsl(var(--primary)/0.25)]"
                    : "border-border/40 hover:border-border bg-muted/10 hover:bg-muted/20"
                }`}
              >
                {isSelected && (
                  <div className="absolute top-3 right-3 w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center">
                    <Check className="w-3 h-3" strokeWidth={3} />
                  </div>
                )}
                <div className="font-semibold text-sm mb-1">{opt.name}</div>
                <div className="text-xs text-muted-foreground leading-relaxed pr-6">
                  {opt.description}
                </div>
              </button>
            );
          })}
          {options.length === 1 && (
            <div className="col-span-full text-xs text-muted-foreground/70 italic mt-2">
              More {tab} options coming soon.
            </div>
          )}
        </div>

        <div className="p-3 border-t border-border/40 text-center text-[10px] tracking-[0.2em] uppercase text-muted-foreground/70">
          Selections save automatically
        </div>
      </div>
    </div>
  );
}
