// @ts-nocheck
// Aggregates chain / mempool / entries state, real-time relay subscription,
// and block-sealing logic. Returns everything Index needs to render.
import { useCallback, useEffect, useRef, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import { getBlockInfo } from "@/lib/blob/chain";
import { GENESIS, BLOCK_TIME, GENESIS_TIME_MS } from "@/lib/blob/constants";

export function useBlockchain(walletRef: React.MutableRefObject<any>) {
  const [chain, setChain] = useState<any[]>([GENESIS]);
  const [mempool, setMempool] = useState<any[]>([]);
  const [entries, setEntries] = useState<any[]>([]);
  const [myEntry, setMyEntry] = useState<any>(null);
  const [blockInfo, setBlock] = useState(getBlockInfo());
  const [newBlock, setNewBlock] = useState<any>(null);

  // Tick block info every second.
  useEffect(() => {
    setBlock(getBlockInfo(chain, entries.length > 0));
    const iv = setInterval(() => setBlock(getBlockInfo(chain, entries.length > 0)), 1000);
    return () => clearInterval(iv);
  }, [chain, entries.length]);

  // Refs to avoid stale closures inside async effects.
  const entriesRef = useRef(entries);
  const chainRef = useRef(chain);
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => { chainRef.current = chain; }, [chain]);

  // ── Initial load + realtime subscription ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const c = await Relay.fetchChain();
      if (cancelled) return;
      const tipHeight = c.length ? c[c.length - 1].height : 0;
      const activeHeight = tipHeight + 1;
      const [m, e] = await Promise.all([
        Relay.fetchMempool(),
        Relay.fetchEntries(activeHeight),
      ]);
      if (cancelled) return;
      if (c.length) setChain(c);
      setMempool(m);
      const expectedSeed = String(getBlockInfo(c.length ? c : [GENESIS], true).seed);
      setEntries(e.filter((en: any) =>
        en.block_seed == null || String(en.block_seed) === expectedSeed
      ));
    })();

    const unsub = Relay.subscribeRelay({
      onBlock: (b) => {
        setChain(prev => {
          if (prev.find(x => x.height === b.height)) return prev;
          return [...prev, b].sort((a, b2) => a.height - b2.height);
        });
        setNewBlock({ ...b, isMine: b.winner === walletRef.current?.address });
        setTimeout(() => setNewBlock(null), 5000);
        setEntries([]);
        setMyEntry(null);
      },
      onTx: (t) => {
        setMempool(prev => prev.find(x => x.id === t.id) ? prev : [...prev, t]);
      },
      onTxRemoved: (id) => {
        setMempool(prev => prev.filter(x => x.id !== id));
      },
      onEntry: (en) => {
        const tip = chainRef.current[chainRef.current.length - 1];
        const activeH = (tip ? Number(tip.height) : 0) + 1;
        if (en.block_height !== activeH) return;
        // Reject entries with a stale/forked block seed — they were playing a
        // different level than the current block and must not appear here.
        const expectedSeed = String(getBlockInfo(chainRef.current, true).seed);
        if (en.block_seed != null && String(en.block_seed) !== expectedSeed) return;
        setEntries(prev => {
          const i = prev.findIndex(x => x.address === en.address);
          if (i === -1) return [...prev, en];
          const copy = prev.slice(); copy[i] = en; return copy;
        });
      },
    });
    return () => { cancelled = true; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh entries when active block changes. Filter out forked submissions
  // whose block_seed doesn't match the seed of the current active block — these
  // come from players who finished a level on the previous seed after the timer
  // expired and would otherwise pollute the next block's entry list.
  useEffect(() => {
    (async () => {
      const e = await Relay.fetchEntries(blockInfo.height);
      const expectedSeed = String(blockInfo.seed);
      const filtered = e.filter((en: any) =>
        en.block_seed == null || String(en.block_seed) === expectedSeed
      );
      setEntries(filtered);
    })();
  }, [blockInfo.height, blockInfo.seed]);

  // Block sealing — both reactive and 10s safety net.
  const sealingRef = useRef(false);
  const attemptSeal = useCallback(async () => {
    if (sealingRef.current) return;
    const tip = chainRef.current[chainRef.current.length - 1];
    const prevHeight = tip ? Number(tip.height) : 0;
    const prevTs = tip ? Number(tip.timestamp) : GENESIS_TIME_MS;
    const elapsedMs = Date.now() - prevTs;
    if (elapsedMs < BLOCK_TIME * 1000) return;
    if (entriesRef.current.length === 0) return;
    const targetHeight = prevHeight + 1;
    if (chainRef.current.find(b => b.height === targetHeight)) return;

    sealingRef.current = true;
    try {
      await new Promise(r => setTimeout(r, Math.random() * 1500));
      if (chainRef.current.find(b => b.height === targetHeight)) return;
      await Relay.sealBlock(targetHeight);
    } finally {
      sealingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (blockInfo.overdue && entries.length > 0) attemptSeal();
    const iv = setInterval(attemptSeal, 10_000);
    return () => clearInterval(iv);
  }, [blockInfo.overdue, blockInfo.height, entries.length, attemptSeal]);

  useEffect(() => {
    if (entries.length > 0) attemptSeal();
  }, [entries.length, attemptSeal]);

  const onEntrySubmit = useCallback(entry => {
    setMyEntry(entry);
    setEntries(e => e.find(x => x.address === entry.address) ? e.map(x => x.address === entry.address ? entry : x) : [...e, entry]);
  }, []);

  const onTxBroadcast = useCallback(tx => {
    setMempool(m => [...m, tx]);
  }, []);

  return {
    chain, mempool, entries, myEntry, blockInfo, newBlock,
    onEntrySubmit, onTxBroadcast,
  };
}
