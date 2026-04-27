import { useCallback, useEffect, useMemo, useState } from "react";
import { BlobNodeClient } from "@web/lib/blobNodeClient";
import { Button } from "@web/components/ui/button";
import { Input } from "@web/components/ui/input";
import { Label } from "@web/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@web/components/ui/select";
import { Loader2, RefreshCw, Server, ExternalLink } from "lucide-react";
import { BUNDLED_NODES, type BundledNode } from "../hooks/useNodeConfig";

// Special select value meaning "user wants to type a custom URL".
const CUSTOM = "__custom__";

type Ping = { url: string; ms: number | null; checking: boolean };

declare global {
  interface Window {
    shellBridge?: { openExternal(url: string): Promise<boolean> };
  }
}

const cleanUrl = (u: string) => u.trim().replace(/\/$/, "");
const isValid = (u: string) => /^https?:\/\//.test(u);

// Color-code latency.
function latencyTone(ms: number | null): string {
  if (ms === null) return "text-destructive";
  if (ms < 150) return "text-emerald-400";
  if (ms < 400) return "text-amber-400";
  return "text-orange-400";
}

function formatPing(p: Ping): string {
  if (p.checking) return "…";
  if (p.ms === null) return "unreachable";
  return `${p.ms} ms`;
}

export function NodeSetupScreen({
  onChosen,
  savedUrls = [],
  rememberCustom,
}: {
  onChosen: (url: string) => void;
  savedUrls?: string[];
  rememberCustom?: (u: string) => void;
}) {
  // Build the list of candidates (bundled + recent customs, de-duped).
  const candidates = useMemo<BundledNode[]>(() => {
    const seen = new Set<string>();
    const out: BundledNode[] = [];
    for (const n of BUNDLED_NODES) {
      if (seen.has(n.url)) continue;
      seen.add(n.url);
      out.push(n);
    }
    for (const u of savedUrls) {
      if (seen.has(u)) continue;
      seen.add(u);
      out.push({ label: u, url: u });
    }
    return out;
  }, [savedUrls]);

  const [pings, setPings] = useState<Record<string, Ping>>(() =>
    Object.fromEntries(candidates.map((c) => [c.url, { url: c.url, ms: null, checking: true } as Ping])),
  );
  const [selected, setSelected] = useState<string>(""); // url or CUSTOM
  const [customDraft, setCustomDraft] = useState("");
  const [customResult, setCustomResult] = useState<"" | "ok" | "fail" | "testing">("");
  const [autoMsg, setAutoMsg] = useState<string>("Pinging nodes…");

  // Identify the bundled node with lowest reachable latency.
  const bestUrl = useMemo(() => {
    let best: { url: string; ms: number } | null = null;
    for (const c of candidates) {
      const p = pings[c.url];
      if (!p || p.ms === null) continue;
      if (!best || p.ms < best.ms) best = { url: c.url, ms: p.ms };
    }
    return best;
  }, [candidates, pings]);

  const scan = useCallback(async () => {
    setPings(Object.fromEntries(candidates.map((c) => [c.url, { url: c.url, ms: null, checking: true } as Ping])));
    setAutoMsg("Pinging nodes…");
    await Promise.all(
      candidates.map(async (c) => {
        const t0 = performance.now();
        const ok = await BlobNodeClient.healthcheck(c.url, 2500);
        const ms = ok ? Math.round(performance.now() - t0) : null;
        setPings((prev) => ({ ...prev, [c.url]: { url: c.url, ms, checking: false } }));
      }),
    );
  }, [candidates]);

  // Initial scan on mount.
  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-select the fastest reachable node once everything settled and the
  // user hasn't picked anything yet.
  useEffect(() => {
    const allDone = candidates.every((c) => pings[c.url] && !pings[c.url].checking);
    if (!allDone) return;
    if (selected) return;
    if (bestUrl) {
      const label = candidates.find((c) => c.url === bestUrl.url)?.label ?? bestUrl.url;
      setSelected(bestUrl.url);
      setAutoMsg(`Auto-selected ${label} — ${bestUrl.ms} ms`);
    } else {
      setAutoMsg("No bundled nodes reachable — pick one or enter a custom URL.");
    }
  }, [candidates, pings, bestUrl, selected]);

  const cleanedCustom = cleanUrl(customDraft);
  const customValid = isValid(cleanedCustom);

  async function testCustom() {
    if (!customValid) return;
    setCustomResult("testing");
    const ok = await BlobNodeClient.healthcheck(cleanedCustom, 3000);
    setCustomResult(ok ? "ok" : "fail");
  }

  function connect() {
    let url = "";
    if (selected === CUSTOM) {
      if (!customValid) return;
      url = cleanedCustom;
      rememberCustom?.(url);
    } else {
      url = selected;
    }
    if (!url) return;
    onChosen(url);
  }

  function openSelfHostGuide() {
    const target = "https://blobchain.network/run-a-node";
    if (window.shellBridge?.openExternal) {
      window.shellBridge.openExternal(target);
    } else {
      window.open(target, "_blank", "noopener");
    }
  }

  const connectDisabled =
    selected === ""
      ? true
      : selected === CUSTOM
      ? !customValid
      : false;

  return (
    <div className="space-y-5">
      {/* Auto-pick status line */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Server className="w-3.5 h-3.5 shrink-0" />
        <span className="flex-1 truncate">{autoMsg}</span>
        <button
          type="button"
          onClick={scan}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          title="Re-scan all nodes"
        >
          <RefreshCw className="w-3 h-3" /> Re-scan
        </button>
      </div>

      {/* Node selector */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Node</Label>
        <Select value={selected} onValueChange={(v) => { setSelected(v); setCustomResult(""); }}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a node…" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Bundled</SelectLabel>
              {candidates.map((c) => {
                const p = pings[c.url] ?? { url: c.url, ms: null, checking: true };
                const isBest = bestUrl?.url === c.url;
                return (
                  <SelectItem key={c.url} value={c.url}>
                    <div className="flex w-full items-center gap-2">
                      <span className="flex-1 truncate">{c.label}</span>
                      {p.checking ? (
                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                      ) : (
                        <span className={`text-[10px] tabular-nums ${latencyTone(p.ms)}`}>
                          {formatPing(p)}
                        </span>
                      )}
                      {isBest && (
                        <span className="text-[10px] uppercase tracking-wide text-emerald-400">best</span>
                      )}
                    </div>
                  </SelectItem>
                );
              })}
            </SelectGroup>
            <SelectGroup>
              <SelectLabel>Other</SelectLabel>
              <SelectItem value={CUSTOM}>Custom URL…</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {/* Custom URL input */}
      {selected === CUSTOM && (
        <div className="space-y-2">
          <Label htmlFor="custom-node" className="text-xs text-muted-foreground">
            Custom node URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="custom-node"
              value={customDraft}
              onChange={(e) => { setCustomDraft(e.target.value); setCustomResult(""); }}
              placeholder="http://localhost:9090"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            <Button
              variant="outline"
              onClick={testCustom}
              disabled={!customValid || customResult === "testing"}
            >
              {customResult === "testing" ? "…" : "Test"}
            </Button>
          </div>
          {customResult === "ok" && (
            <p className="text-xs text-emerald-400">✓ Node reachable</p>
          )}
          {customResult === "fail" && (
            <p className="text-xs text-destructive">
              Couldn't reach {cleanedCustom}. You can still continue — the wallet will keep retrying.
            </p>
          )}
        </div>
      )}

      {/* Connect */}
      <Button className="w-full" onClick={connect} disabled={connectDisabled}>
        Connect →
      </Button>

      {/* Self-host CTA */}
      <div className="relative pt-2">
        <div className="absolute inset-x-0 top-0 flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground/60">
          <span className="flex-1 h-px bg-border" /> or <span className="flex-1 h-px bg-border" />
        </div>
        <div className="pt-5 text-center space-y-2">
          <p className="text-xs text-muted-foreground">
            Want full sovereignty? Run your own full node.
          </p>
          <Button
            variant="outline"
            className="w-full"
            onClick={openSelfHostGuide}
          >
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            Run your own node
          </Button>
        </div>
      </div>
    </div>
  );
}
