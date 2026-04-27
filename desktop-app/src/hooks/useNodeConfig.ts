import { useCallback, useEffect, useState } from "react";

const DEFAULT_NODE = "http://localhost:9090";

// Bundled fallback list — shipped inside the desktop app so it works even
// if blobchain.network is completely offline. URLs here are placeholders
// until the real public nodes are live; structure is what matters.
export type BundledNode = { label: string; url: string };
export const BUNDLED_NODES: BundledNode[] = [
  { label: "Official (blobchain.network)", url: "https://node.blobchain.network" },
  { label: "Community node — EU",          url: "https://node-eu.blobchain.network" },
  { label: "Community node — US",          url: "https://node-us.blobchain.network" },
  { label: "Local node",                   url: "http://localhost:9090" },
];

// Loads + persists the user's node URL list via the Electron bridge.
// Returns sane defaults instantly so the UI never shows a flash of empty
// state, then upgrades once disk read completes.
export function useNodeConfig() {
  // Start empty so we can detect "first run" → force the user through node setup.
  const [nodeUrl, setNodeUrlState] = useState<string>("");
  const [savedUrls, setSavedUrlsState] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  // True once the user has explicitly chosen a node (or we read one from disk).
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await window.nodeConfigBridge?.read();
        if (!alive || !raw) { setLoaded(true); return; }
        const cfg = JSON.parse(raw);
        if (cfg.current && typeof cfg.current === "string") {
          setNodeUrlState(cfg.current);
          setConfigured(true);
        }
        if (Array.isArray(cfg.saved)) setSavedUrlsState(cfg.saved);
      } catch { /* defaults */ }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, []);

  // Persist after load completes (avoid clobbering disk on first render).
  useEffect(() => {
    if (!loaded || !configured) return;
    window.nodeConfigBridge?.write(
      JSON.stringify({ current: nodeUrl, saved: savedUrls }),
    );
  }, [loaded, configured, nodeUrl, savedUrls]);

  const setNodeUrl = useCallback((u: string) => {
    setNodeUrlState(u);
    setConfigured(true);
  }, []);
  const setSavedUrls = useCallback((u: string[]) => setSavedUrlsState(u), []);

  // Append a custom URL to the recent list (de-duped, max 5).
  const rememberCustom = useCallback((u: string) => {
    setSavedUrlsState((prev) => {
      const next = [u, ...prev.filter((x) => x !== u)].slice(0, 5);
      return next;
    });
  }, []);

  return { nodeUrl, setNodeUrl, savedUrls, setSavedUrls, rememberCustom, configured, loaded };
}

export { DEFAULT_NODE };
