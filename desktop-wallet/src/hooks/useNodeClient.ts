import { useEffect, useRef, useState } from "react";
import { BlobNodeClient, type NodeStatus } from "@web/lib/blobNodeClient";

export type NodeData = {
  client: BlobNodeClient | null;
  status: NodeStatus;
  tipHeight: number;
  chain: any[];
  mempool: any[];
  online: boolean;
};

// Owns the node client lifecycle: tears down + rebuilds on URL change,
// dedupes blocks/txs, exposes connection state. Reconnects automatically
// when the OS reports we're back online.
export function useNodeClient(nodeUrl: string): NodeData {
  const clientRef = useRef<BlobNodeClient | null>(null);
  const [status, setStatus] = useState<NodeStatus>("idle");
  const [tipHeight, setTipHeight] = useState(0);
  const [chain, setChain] = useState<any[]>([]);
  const [mempool, setMempool] = useState<any[]>([]);
  const [online, setOnline] = useState<boolean>(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [client, setClient] = useState<BlobNodeClient | null>(null);

  // Browser online/offline events — useful for desktop apps too.
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  useEffect(() => {
    if (!nodeUrl) return;
    clientRef.current?.close();
    const c = new BlobNodeClient(nodeUrl);
    clientRef.current = c;
    setClient(c);
    setStatus("idle");
    setChain([]);
    setMempool([]);
    setTipHeight(0);

    c.setHandlers({
      onStatus: setStatus,
      onTip: (t) => setTipHeight(t.height),
      onBlock: (b) =>
        setChain((prev) => {
          // Maintain unique-by-height, sorted ascending.
          if (prev.some((x) => x.height === b.height)) {
            return prev.map((x) => (x.height === b.height ? b : x));
          }
          const next = prev.concat(b);
          next.sort((a, z) => a.height - z.height);
          return next;
        }),
      onTx: (t) => setMempool((m) => (m.find((x) => x.id === t.id) ? m : [...m, t])),
    });
    c.connect();

    const refreshMempool = async () => {
      const mp = await c.fetchMempool();
      setMempool(mp);
    };
    const refreshTimer = window.setTimeout(refreshMempool, 1500);

    return () => {
      window.clearTimeout(refreshTimer);
      c.close();
      if (clientRef.current === c) {
        clientRef.current = null;
        setClient(null);
      }
    };
  }, [nodeUrl]);

  // When OS reports we're back online, nudge the client to reconnect.
  useEffect(() => {
    if (!online) return;
    const c = clientRef.current;
    if (c && (status === "closed" || status === "error")) c.connect();
  }, [online, status]);

  return { client, status, tipHeight, chain, mempool, online };
}
