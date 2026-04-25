// Lightweight ring-buffer of mempool snapshots for inline sparklines.
// Frontend-only — no relay or backend changes.
import { useEffect, useRef, useState } from "react";

export type MempoolSample = {
  ts: number;
  count: number;
  vbytes: number;
  fees: number;
  incoming: number;   // new tx ids since previous sample
  confirmed: number;  // tx ids that left mempool since previous sample
};

export function useMempoolHistory(
  mempool: any[],
  estimateBytes: (t: any) => number,
  capacity = 60,
): MempoolSample[] {
  const [samples, setSamples] = useState<MempoolSample[]>([]);
  const prevIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const id = setInterval(() => {
      const ids = new Set((mempool || []).map((t: any) => t.id));
      let incoming = 0, confirmed = 0;
      for (const x of ids) if (!prevIdsRef.current.has(x)) incoming++;
      for (const x of prevIdsRef.current) if (!ids.has(x)) confirmed++;
      let vbytes = 0, fees = 0;
      for (const t of mempool || []) {
        vbytes += estimateBytes(t);
        fees += Number(t.fee || 0);
      }
      const sample: MempoolSample = {
        ts: Date.now(),
        count: ids.size,
        vbytes,
        fees,
        incoming,
        confirmed,
      };
      prevIdsRef.current = ids;
      setSamples(prev => {
        const next = prev.length >= capacity ? prev.slice(prev.length - capacity + 1) : prev.slice();
        next.push(sample);
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [mempool, estimateBytes, capacity]);

  return samples;
}
