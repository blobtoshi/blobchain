// Aggregates chain / mempool / entries state, real-time relay subscription,
// and block-sealing logic. Returns everything Index needs to render.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import type { Block, Tx, Entry } from "@/lib/blobRelay";
import { getBlockInfo } from "@/lib/blob/chain";
import { GENESIS, BLOCK_TIME, GENESIS_TIME_MS } from "@/lib/blob/constants";

export type BlockInfo = ReturnType<typeof getBlockInfo>;
export type BlockTime = { remaining: number; elapsed: number; overtime: number };
export type NewBlock = Block & { isMine: boolean };
export type WalletLike = { address: string; [k: string]: unknown } | null;
export type SubmittedEntry = Entry & {
  frame_count?: number;
  inputs?: string;
  inputs_hash?: string;
  engine_version?: number;
  submitted_at?: string;
};

export function useBlockchain(walletRef: React.MutableRefObject<WalletLike>) {
  const [chain, setChain] = useState<Block[]>([GENESIS as unknown as Block]);
  const [mempool, setMempool] = useState<Tx[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [myEntry, setMyEntry] = useState<Entry | null>(null);
  const [rawInfo, setRawInfo] = useState<BlockInfo>(getBlockInfo());
  const [newBlock, setNewBlock] = useState<NewBlock | null>(null);

  // Tick block info every second.
  // Skip the state update when nothing observable changed — otherwise this
  // forces a parent re-render every second even when remaining/elapsed are
  // identical (e.g. immediately after a block seal). Each unnecessary render
  // walks calcBalance over the entire chain+mempool, which produces visible
  // GC stutter in the running game.
  // Pending commits don't count toward "block has entries" — only revealed
  // entries (score != null) trigger sealing or close the awaiting-miner state.
  const revealedCount = entries.reduce((n, e) => n + (e.pending ? 0 : 1), 0);
  useEffect(() => {
    const update = () => {
      const next = getBlockInfo(chain, revealedCount > 0);
      setRawInfo((prev) => {
        if (
          prev.height === next.height &&
          prev.seed === next.seed &&
          prev.reward === next.reward &&
          prev.awaitingMiner === next.awaitingMiner &&
          prev.overdue === next.overdue &&
          prev.prevHash === next.prevHash &&
          prev.remaining === next.remaining &&
          prev.elapsed === next.elapsed &&
          prev.overtime === next.overtime
        ) {
          return prev;
        }
        return next;
      });
    };
    update();
    const iv = setInterval(update, 1000);
    return () => clearInterval(iv);
  }, [chain, revealedCount]);

  // Split the per-second tick into two stable references:
  //   • blockInfo: re-creates only when height / seed / reward / awaitingMiner /
  //     overdue / prevHash change. Components that only care about block identity
  //     (the running game canvas, the leaderboard, the explorer) skip re-renders
  //     on the per-second countdown ticks.
  //   • blockTime: a small object that *does* update every second. Components
  //     that show the countdown subscribe to this one only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const blockInfo = useMemo<BlockInfo>(() => rawInfo, [
    rawInfo.height, rawInfo.seed, rawInfo.reward,
    rawInfo.awaitingMiner, rawInfo.overdue, rawInfo.prevHash,
  ]);
  const blockTime = useMemo<BlockTime>(() => ({
    remaining: rawInfo.remaining,
    elapsed: rawInfo.elapsed,
    overtime: rawInfo.overtime,
  }), [rawInfo.remaining, rawInfo.elapsed, rawInfo.overtime]);

  // Refs to avoid stale closures inside async effects.
  const entriesRef = useRef(entries);
  const chainRef = useRef(chain);
  const blockInfoRef = useRef(blockInfo);
  const lastFetchedKeyRef = useRef<string>("");
  const inFlightFetchRef = useRef<string>("");
  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => { chainRef.current = chain; }, [chain]);
  useEffect(() => { blockInfoRef.current = blockInfo; }, [blockInfo]);

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
      const initialInfo = getBlockInfo(c.length ? c : [GENESIS], true);
      const expectedSeed = String(initialInfo.seed);
      lastFetchedKeyRef.current = `${initialInfo.height}:${initialInfo.seed}`;
      setEntries(e.filter((en) =>
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
        // Mark the new active block as already "fetched" (empty) so the
        // height/seed effect doesn't race a redundant fetchEntries call.
        const newChain = [...chainRef.current.filter(x => x.height !== b.height), b]
          .sort((a, b2) => a.height - b2.height);
        const nextInfo = getBlockInfo(newChain, false);
        lastFetchedKeyRef.current = `${nextInfo.height}:${nextInfo.seed}`;
        setEntries([]);
// Only clear myEntry if it belongs to the previous block, not the new one
setMyEntry(prev => {
  if (!prev) return null;
  const nextHeight = nextInfo.height;
  if (Number(prev.block_height) < nextHeight) return null;
  return prev;
});
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
  //
  // Guarded against races with onBlock (which proactively clears entries) and
  // the initial-load effect: we skip if we've already fetched this height+seed,
  // and we drop the response if the active block has moved on while in flight.
  useEffect(() => {
    const key = `${blockInfo.height}:${blockInfo.seed}`;
    if (lastFetchedKeyRef.current === key) return;
    if (inFlightFetchRef.current === key) return;
    inFlightFetchRef.current = key;
    (async () => {
      try {
        const e = await Relay.fetchEntries(blockInfo.height);
        // Stale response — active block changed while we were fetching.
        const currentKey = `${blockInfoRef.current.height}:${blockInfoRef.current.seed}`;
        if (currentKey !== key) return;
        const expectedSeed = String(blockInfo.seed);
        const filtered = e.filter((en) =>
          en.block_seed == null || String(en.block_seed) === expectedSeed
        );
        lastFetchedKeyRef.current = key;
        setEntries(filtered);
      } finally {
        if (inFlightFetchRef.current === key) inFlightFetchRef.current = "";
      }
    })();
  }, [blockInfo.height, blockInfo.seed]);

  // Lightweight poll while the active block is open so newly-arrived commits
  // (which don't broadcast a realtime onEntry until reveal) surface in the UI.
  // Merges server pending rows in without clobbering already-revealed entries.
  useEffect(() => {
    const expectedSeed = String(blockInfo.seed);
    const activeH = blockInfo.height;
    let cancelled = false;
    const poll = async () => {
      try {
        const e = await Relay.fetchEntries(activeH);
        if (cancelled) return;
        const filtered = e.filter((en) =>
          en.block_seed == null || String(en.block_seed) === expectedSeed
        );
        setEntries((prev) => {
          // Preserve revealed rows already in state; upgrade pending → revealed
          // when the server has the reveal.
          const byAddr = new Map(prev.map((x) => [x.address, x]));
          for (const en of filtered) {
            const existing = byAddr.get(en.address);
            if (!existing) {
              byAddr.set(en.address, en);
            } else if (existing.pending && !en.pending) {
              byAddr.set(en.address, en);
            }
          }
          // Drop locally-known rows the server has dropped (e.g. forked).
          const serverAddrs = new Set(filtered.map((x) => x.address));
          const merged = Array.from(byAddr.values()).filter(
            (x) => serverAddrs.has(x.address) || !x.pending,
          );
          // Avoid setState if nothing actually changed.
          if (merged.length === prev.length &&
              merged.every((x, i) => x === prev[i])) {
            return prev;
          }
          return merged;
        });
      } catch { /* ignore transient errors */ }
    };
    const iv = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(iv); };
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
    if (entriesRef.current.every((e) => e.pending)) return;
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
    if (blockInfo.overdue && revealedCount > 0) attemptSeal();
    const iv = setInterval(attemptSeal, 10_000);
    return () => clearInterval(iv);
  }, [blockInfo.overdue, blockInfo.height, revealedCount, attemptSeal]);

  useEffect(() => {
    if (revealedCount > 0) attemptSeal();
  }, [revealedCount, attemptSeal]);

  const onEntrySubmit = useCallback((entry: SubmittedEntry) => {
    const current = blockInfoRef.current;
    const matchesActiveBlock =
      Number(entry.block_height) === Number(current.height) &&
      (entry.block_seed == null || String(entry.block_seed) === String(current.seed));

    if (!matchesActiveBlock) return;

    setMyEntry(entry);
    setEntries((e) =>
      e.find((x) => x.address === entry.address)
        ? e.map((x) => (x.address === entry.address ? entry : x))
        : [...e, entry]
    );
  }, []);

  const onTxBroadcast = useCallback((tx: Tx) => {
    setMempool((m) => (m.find((x) => x.id === tx.id) ? m : [...m, tx]));
  }, []);

  return {
    chain, mempool, entries, myEntry, blockInfo, blockTime, newBlock,
    onEntrySubmit, onTxBroadcast,
  };
}
