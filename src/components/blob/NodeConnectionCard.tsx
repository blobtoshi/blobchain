// "Node connection" card for the Network view. Lets the user:
//   • See the currently active node + latency.
//   • Pick "Auto (fastest)" or pin a specific node.
//   • Add/remove custom node URLs.
//   • Re-scan all nodes for latency.

import { useEffect, useState } from "react";
import {
  onRelayStatus, setPinnedNode, addCustomNode, removeCustomNode, refreshNodeHealth,
  type RelayStatus,
} from "@/lib/blobRelay";
import { BUNDLED_NODES } from "@/lib/nodePool";
import { BlobNodeClient } from "@/lib/blobNodeClient";
import { Loader2, RefreshCw, Server, Plus, X, Check, ShieldAlert } from "lucide-react";

const AUTO = "__auto__";

function latencyTone(ms: number | null): string {
  if (ms === null) return "text-destructive";
  if (ms < 150) return "text-emerald-400";
  if (ms < 400) return "text-amber-400";
  return "text-orange-400";
}

export default function NodeConnectionCard() {
  const [status, setStatus] = useState<RelayStatus>({
    activeUrl: null, health: [], pinned: null, custom: [], consensus: null,
  });
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"" | "ok" | "fail">("");

  useEffect(() => {
    const off = onRelayStatus((s) => setStatus(s));
    return () => { off(); };
  }, []);

  const isAuto = status.pinned === null;
  const activeHealth = status.health.find((h) => h.url === status.activeUrl);
  const cleanedDraft = draft.trim().replace(/\/+$/, "");
  const validDraft = /^https?:\/\//.test(cleanedDraft);
  const consensus = status.consensus;
  const divergedNodes = status.health.filter((h) => h.diverged);
  const activeDiverged = !!activeHealth?.diverged;

  async function rescan() {
    setScanning(true);
    try { await refreshNodeHealth(); }
    finally { setScanning(false); }
  }

  async function testCustom() {
    if (!validDraft) return;
    setTesting(true); setTestResult("");
    const ok = await BlobNodeClient.healthcheck(cleanedDraft, 3000);
    setTestResult(ok ? "ok" : "fail");
    setTesting(false);
  }

  function saveCustom() {
    if (!validDraft) return;
    addCustomNode(cleanedDraft);
    setDraft(""); setTestResult("");
  }

  function pickValue(): string { return status.pinned ?? AUTO; }

  function onPick(value: string) {
    if (value === AUTO) setPinnedNode(null);
    else setPinnedNode(value);
  }

  return (
    <div className="glass p-5 rounded-md">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="label-eyebrow">Node connection</div>
          <div className="text-sm text-foreground/60 mt-0.5">
            {isAuto ? "Auto-selecting fastest healthy node" : "Pinned to a specific node"}
          </div>
        </div>
        <button
          type="button"
          onClick={rescan}
          disabled={scanning}
          className="inline-flex items-center gap-1.5 text-[11px] text-foreground/60 hover:text-foreground transition-colors disabled:opacity-50"
          title="Re-scan all nodes"
        >
          {scanning
            ? <Loader2 className="w-3 h-3 animate-spin" />
            : <RefreshCw className="w-3 h-3" />}
          Re-scan
        </button>
      </div>

      {/* Active node summary */}
      <div className={`rounded-md border p-3 mb-3 ${
        status.activeUrl
          ? "border-primary/30 bg-primary/[0.05]"
          : "border-[hsl(var(--danger)/0.4)] bg-[hsl(var(--danger)/0.06)]"
      }`}>
        <div className="flex items-center gap-2">
          <Server className="w-3.5 h-3.5 text-foreground/60 shrink-0" />
          <span className="text-xs text-foreground/60 shrink-0">Active</span>
          <span className="text-sm font-medium num truncate flex-1">
            {status.activeUrl ?? "All nodes unreachable"}
          </span>
          {activeHealth && (
            <span className={`text-[11px] tabular-nums ${latencyTone(activeHealth.ms)}`}>
              {activeHealth.ms !== null ? `${activeHealth.ms} ms` : "down"}
            </span>
          )}
        </div>
      </div>

      {/* Picker */}
      <div className="space-y-2 mb-3">
        <label className="label-eyebrow block">Choose node</label>
        <select
          value={pickValue()}
          onChange={(e) => onPick(e.target.value)}
          className="w-full px-3 py-2.5 rounded-md bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
        >
          <option value={AUTO}>Auto (fastest healthy)</option>
          <optgroup label="Bundled">
            {BUNDLED_NODES.map((u) => {
              const h = status.health.find((x) => x.url === u);
              const lat = h?.ms !== null && h?.ms !== undefined ? `${h.ms}ms` : (h?.ok === false ? "down" : "—");
              return <option key={u} value={u}>{u} ({lat})</option>;
            })}
          </optgroup>
          {status.custom.length > 0 && (
            <optgroup label="Custom">
              {status.custom.map((u) => {
                const h = status.health.find((x) => x.url === u);
                const lat = h?.ms !== null && h?.ms !== undefined ? `${h.ms}ms` : (h?.ok === false ? "down" : "—");
                return <option key={u} value={u}>{u} ({lat})</option>;
              })}
            </optgroup>
          )}
        </select>
      </div>

      {/* Custom URL row */}
      <div className="space-y-2 mb-3">
        <label className="label-eyebrow block">Add custom node</label>
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setTestResult(""); }}
            placeholder="https://my-node.example.com"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="num flex-1 px-3 py-2 rounded-md bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-xs"
          />
          <button
            type="button"
            onClick={testCustom}
            disabled={!validDraft || testing}
            className="px-3 py-2 rounded-md border border-border text-xs text-muted-foreground hover:text-foreground transition disabled:opacity-40"
          >
            {testing ? "…" : "Test"}
          </button>
          <button
            type="button"
            onClick={saveCustom}
            disabled={!validDraft}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition disabled:opacity-40"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
        {testResult === "ok" && (
          <div className="flex items-center gap-1 text-[11px] text-emerald-400">
            <Check className="w-3 h-3" /> Reachable
          </div>
        )}
        {testResult === "fail" && (
          <div className="text-[11px] text-destructive">
            Couldn't reach {cleanedDraft}.
          </div>
        )}
      </div>

      {/* Saved customs list */}
      {status.custom.length > 0 && (
        <div className="pt-3 border-t border-foreground/5">
          <div className="label-eyebrow mb-2">Your custom nodes</div>
          <div className="space-y-1.5">
            {status.custom.map((u) => {
              const h = status.health.find((x) => x.url === u);
              return (
                <div key={u} className="flex items-center gap-2 text-xs">
                  <span className="num truncate flex-1">{u}</span>
                  <span className={`tabular-nums shrink-0 ${latencyTone(h?.ms ?? null)}`}>
                    {h?.ms !== null && h?.ms !== undefined ? `${h.ms} ms` : "down"}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeCustomNode(u)}
                    className="p-1 text-muted-foreground hover:text-destructive transition"
                    title="Forget this node"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
