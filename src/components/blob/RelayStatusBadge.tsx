// Tiny dev-only indicator: shows the active node URL + WS status + tip height.
// Rendered only in DEV builds. Hidden in production.

import { useEffect, useState } from "react";
import { onRelayStatus, getNodeClient, type RelayStatus } from "@/lib/blobRelay";
import type { NodeStatus } from "@/lib/blobNodeClient";

export function RelayStatusBadge() {
  const [status, setStatus] = useState<RelayStatus>({
    activeUrl: null, health: [], pinned: null, custom: [], consensus: null,
  });
  const [wsStatus, setWsStatus] = useState<NodeStatus>("idle");
  const [tip, setTip] = useState<number>(0);

  useEffect(() => {
    const off = onRelayStatus((s) => setStatus(s));
    return () => { off(); };
  }, []);

  useEffect(() => {
    const client = getNodeClient();
    if (!client) { setWsStatus("idle"); setTip(0); return; }
    setWsStatus(client.getStatus());
    setTip(client.getTipHeight());
    const iv = window.setInterval(() => {
      const c = getNodeClient();
      if (!c) return;
      setWsStatus(c.getStatus());
      setTip(c.getTipHeight());
    }, 1000);
    return () => window.clearInterval(iv);
  }, [status.activeUrl]);

  const dot =
    !status.activeUrl ? "bg-destructive"
      : wsStatus === "open" ? "bg-emerald-500"
      : wsStatus === "syncing" || wsStatus === "connecting" ? "bg-amber-500"
      : "bg-destructive";

  const label = status.activeUrl
    ? status.activeUrl.replace(/^https?:\/\//, "")
    : "no node";

  return (
    <div
      className="fixed bottom-2 right-2 z-50 flex items-center gap-2 rounded-md border border-border bg-background/90 px-2 py-1 text-[10px] font-mono text-muted-foreground shadow-sm backdrop-blur"
      title={`Node: ${status.activeUrl ?? "(none)"} · WS: ${wsStatus} · tip #${tip}`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <span className="uppercase tracking-wider truncate max-w-[160px]">{label}</span>
      <span className="opacity-50">·</span>
      <span>{wsStatus}</span>
      <span className="opacity-50">·</span>
      <span>#{tip}</span>
    </div>
  );
}
