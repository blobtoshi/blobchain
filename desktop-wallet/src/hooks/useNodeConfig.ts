import { useCallback, useEffect, useState } from "react";

const DEFAULT_NODE = "http://localhost:9090";

// Loads + persists the user's node URL list via the Electron bridge.
// Returns sane defaults instantly so the UI never shows a flash of empty
// state, then upgrades once disk read completes.
export function useNodeConfig() {
  const [nodeUrl, setNodeUrlState] = useState<string>(DEFAULT_NODE);
  const [savedUrls, setSavedUrlsState] = useState<string[]>([DEFAULT_NODE]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const raw = await window.nodeConfigBridge?.read();
        if (!alive || !raw) { setLoaded(true); return; }
        const cfg = JSON.parse(raw);
        if (cfg.current && typeof cfg.current === "string") setNodeUrlState(cfg.current);
        if (Array.isArray(cfg.saved)) setSavedUrlsState(cfg.saved);
      } catch { /* defaults */ }
      finally { if (alive) setLoaded(true); }
    })();
    return () => { alive = false; };
  }, []);

  // Persist after load completes (avoid clobbering disk on first render).
  useEffect(() => {
    if (!loaded) return;
    window.nodeConfigBridge?.write(
      JSON.stringify({ current: nodeUrl, saved: savedUrls }),
    );
  }, [loaded, nodeUrl, savedUrls]);

  const setNodeUrl = useCallback((u: string) => setNodeUrlState(u), []);
  const setSavedUrls = useCallback((u: string[]) => setSavedUrlsState(u), []);

  return { nodeUrl, setNodeUrl, savedUrls, setSavedUrls };
}

export { DEFAULT_NODE };
