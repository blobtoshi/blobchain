// Tiny dev-only indicator: shows current relay mode + WS status + tip height.
// Rendered only in DEV builds. Hidden in production.

import { useEffect, useState } from "react";
import { onRelayModeChange, getNodeClient, type RelayMode } from "@/lib/blobRelay";
import type { NodeStatus } from "@/lib/blobNodeClient";

export function RelayStatusBadge() {
  const [mode, setMode] = useState<RelayMode>("supabase");
  const [wsStatus, setWsStatus] = useState<NodeStatus>("idle");
  const [tip, setTip] = useState<number>(0);

  useEffect(() => {
    const off = onRelayModeChange((m) => setMode(m));
    return () => { off(); };
  }, []);

  useEffect(() => {
    if (mode !== "node") return;
    const client = getNodeClient();
    if (!client) return;
    setWsStatus(client.getStatus());
    setTip(client.getTipHeight());
    // The client only emits status via setHandlers; we don't want to clobber
    // blobRelay's handlers, so we poll the client's getters every second.
    const iv = window.setInterval(() => {
      setWsStatus(client.getStatus());
      setTip(client.getTipHeight());
    }, 1000);
    return () => window.clearInterval(iv);
  }, [mode]);

  const dot =
    mode === "supabase" ? "bg-muted-foreground"
      : wsStatus === "open" ? "bg-emerald-500"
      : wsStatus === "syncing" || wsStatus === "connecting" ? "bg-amber-500"
      : "bg-destructive";

  return (
    <div
      className="fixed bottom-2 right-2 z-50 flex items-center gap-2 rounded-md border border-border bg-background/90 px-2 py-1 text-[10px] font-mono text-muted-foreground shadow-sm backdrop-blur"
      title={`Relay: ${mode} · WS: ${wsStatus} · tip #${tip}`}
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      <span className="uppercase tracking-wider">{mode}</span>
      {mode === "node" && (
        <>
          <span className="opacity-50">·</span>
          <span>{wsStatus}</span>
          <span className="opacity-50">·</span>
          <span>#{tip}</span>
        </>
      )}
    </div>
  );
}
