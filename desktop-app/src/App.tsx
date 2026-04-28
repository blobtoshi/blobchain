import { useEffect, useState } from "react";
import { HashRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster as Sonner } from "@web/components/ui/sonner";
import { Toaster } from "@web/components/ui/toaster";
import { TooltipProvider } from "@web/components/ui/tooltip";
import BlobChainApp from "@web/pages/BlobChainApp";
import { setPinnedNode } from "@web/lib/blobRelay";
import { initNodePool, type StorageAdapter } from "@web/lib/nodePool";

import { useNodeConfig } from "./hooks/useNodeConfig";
import { NodeSetupScreen } from "./screens/NodeSetupScreen";

declare global {
  interface Window {
    menuBridge?: { onMenuEvent(cb: (event: string) => void): () => void };
    nodeConfigBridge?: { read(): Promise<string | null>; write(json: string): Promise<void> };
  }
}

// Disk-backed storage adapter for the shared nodePool. Mirrors the
// localStorage shape but persists to the Electron user-data directory so
// the desktop app remembers your pinned/custom nodes across launches.
function createDesktopStorage(): StorageAdapter {
  let cache: { pinned: string | null; custom: string[] } = { pinned: null, custom: [] };
  // Best-effort sync read — on first call we may not have data yet, but the
  // hook below also writes through `setPinnedNode` which triggers persistence.
  return {
    read: () => cache,
    write: (cfg) => {
      cache = cfg;
      try {
        window.nodeConfigBridge?.write(
          JSON.stringify({ current: cfg.pinned ?? "", saved: cfg.custom, pinned: cfg.pinned, custom: cfg.custom }),
        );
      } catch { /* ignore */ }
    },
  };
}

const queryClient = new QueryClient();

export default function App() {
  const { nodeUrl, setNodeUrl, savedUrls, rememberCustom, configured, loaded } = useNodeConfig();
  const [relayReady, setRelayReady] = useState(false);

  // Initialize the shared node pool with disk-backed storage exactly once.
  useEffect(() => {
    initNodePool(createDesktopStorage());
  }, []);

  // As soon as the user picks a node, pin the relay's pool to it.
  useEffect(() => {
    if (!configured || !nodeUrl) return;
    setPinnedNode(nodeUrl);
    setRelayReady(true);
  }, [configured, nodeUrl]);

  // Bridge native menu/shortcut events into DOM CustomEvents that
  // BlobChainApp (and any inner component) can listen for.
  useEffect(() => {
    const off = window.menuBridge?.onMenuEvent((evt) => {
      if (evt.startsWith("nav:")) {
        const screen = evt.slice(4); // mine | wallet | chain | network (no bridge on desktop)
        window.dispatchEvent(new CustomEvent("blob:nav", { detail: screen }));
      } else if (evt === "settings:open") {
        window.dispatchEvent(new CustomEvent("blob:settings"));
      } else if (evt === "lock") {
        window.dispatchEvent(new CustomEvent("blob:lock"));
      }
    });
    return () => { off?.(); };
  }, []);

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background text-muted-foreground text-sm">
        Loading…
      </div>
    );
  }

  // Node-first gate: nothing else loads until a node is chosen.
  if (!configured || !relayReady) {
    return (
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Toaster />
          <Sonner />
          <div className="min-h-screen bg-background flex items-center justify-center p-6">
            <div className="w-full max-w-md glass-hi p-8 space-y-4">
              <div className="text-center space-y-1">
                <h1 className="text-xl font-semibold tracking-tight">BLOB Chain Desktop</h1>
                <p className="text-xs text-muted-foreground">
                  Pick a full node to connect to. You can change it anytime later.
                </p>
              </div>
              <NodeSetupScreen onChosen={setNodeUrl} savedUrls={savedUrls} rememberCustom={rememberCustom} />
            </div>
          </div>
        </TooltipProvider>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <HashRouter>
          {/* Bridge runs only on the website (custodial) — hide it in desktop. */}
          <BlobChainApp disableBridge />
        </HashRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
