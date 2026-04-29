// Cross-node chain tip consensus.
//
// Mitigates eclipse attacks: a client connected to a single malicious node
// could be served a fabricated chain. Even with the node pool's latency-based
// failover, a single attacker-controlled node could still be picked if it
// happens to be fastest (or pinned).
//
// This module independently polls /chain/tip from EVERY known healthy node
// at a regular cadence. It then computes the majority view at the highest
// height that has quorum, and flags any node whose tip diverges from the
// majority as "quarantined". The pool consults this quarantine list when
// picking the active node and during failover, so a lone liar can never be
// selected as the active node.
//
// Notes on chain dynamics:
//   • Honest nodes can briefly disagree at the tip while a new block
//     propagates. We avoid false positives by comparing tips at
//     `consensusHeight = max(height) - REORG_DEPTH` — a depth deeper than
//     any expected propagation gap. A node is only flagged when it disagrees
//     about already-finalized history.
//   • We need at least MIN_QUORUM honest peers to even attempt consensus.
//     Below that, we fall back to "no opinion" rather than guess.

import { BlobNodeClient } from "@/lib/blobNodeClient";
import type { ChainTip, Block } from "@/lib/wsProtocol";

export type NodeConsensus = {
  url: string;
  // Hash this node reported at the consensus height. null = couldn't reach,
  // or node is too far behind to have an opinion at that height.
  hashAtConsensusHeight: string | null;
  // Reported tip height at probe time (informational).
  reportedTipHeight: number | null;
  // True iff hashAtConsensusHeight disagrees with the majority hash.
  diverged: boolean;
  checkedAt: number;
};

export type ConsensusSnapshot = {
  // Height we compared at (deepest height with a clear majority). null if
  // we don't have enough peers to form an opinion yet.
  consensusHeight: number | null;
  // The majority hash at consensusHeight, or null if no quorum.
  consensusHash: string | null;
  // Number of nodes that agreed with the majority.
  agreeing: number;
  // Total number of nodes that contributed an opinion at consensusHeight.
  participants: number;
  perNode: NodeConsensus[];
  checkedAt: number;
};

// How many blocks back from the highest reported tip to compare. Block time
// in BLOB CHAIN is ~10s; gossip should propagate well under that window, so
// 2 blocks back is comfortably "settled" without being ancient.
const REORG_DEPTH = 2;

// Need at least this many independent participants before we trust any
// majority result enough to quarantine a divergent node. With fewer than
// this, a single lying node could form its own "majority of one".
const MIN_QUORUM = 3;

// Per-node probe timeout — must stay small so a slow/malicious node can't
// stall the whole consensus round.
const PROBE_TIMEOUT_MS = 3000;

function emptySnapshot(perNode: NodeConsensus[]): ConsensusSnapshot {
  return {
    consensusHeight: null,
    consensusHash: null,
    agreeing: 0,
    participants: 0,
    perNode,
    checkedAt: Date.now(),
  };
}

async function fetchTipFast(url: string): Promise<ChainTip | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const r = await fetch(`${url.replace(/\/$/, "")}/chain/tip`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as ChainTip;
  } catch { return null; }
}

async function fetchHashAt(url: string, height: number): Promise<string | null> {
  if (height <= 0) return null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const r = await fetch(
      `${url.replace(/\/$/, "")}/blocks?from=${height}&limit=1`,
      { signal: ctl.signal },
    );
    clearTimeout(t);
    if (!r.ok) return null;
    const blocks = (await r.json()) as Block[];
    const b = blocks.find((x) => Number(x.height) === height);
    return b ? String(b.hash ?? "") : null;
  } catch { return null; }
}

// Run one round of cross-node consensus over the given URLs.
export async function runConsensusRound(urls: string[]): Promise<ConsensusSnapshot> {
  if (urls.length === 0) return emptySnapshot([]);

  // Step 1: gather every node's current tip in parallel.
  const tips = await Promise.all(urls.map(async (url) => ({
    url,
    tip: await fetchTipFast(url),
  })));

  const reachable = tips.filter((x) => x.tip !== null);
  if (reachable.length < MIN_QUORUM) {
    // Not enough peers to form consensus — record per-node info but no verdict.
    const perNode: NodeConsensus[] = tips.map(({ url, tip }) => ({
      url,
      hashAtConsensusHeight: null,
      reportedTipHeight: tip ? Number(tip.height) : null,
      diverged: false,
      checkedAt: Date.now(),
    }));
    return emptySnapshot(perNode);
  }

  // Step 2: pick the consensus height. Use the highest reported tip minus
  // REORG_DEPTH so we compare at a height every honest node should already
  // have sealed.
  const maxTipHeight = Math.max(...reachable.map((x) => Number(x.tip!.height)));
  const consensusHeight = Math.max(1, maxTipHeight - REORG_DEPTH);

  // Step 3: ask each reachable node what hash they have at consensusHeight.
  // Optimisation: if a node's tip == consensusHeight, we already have its
  // hash from the tip response.
  const hashes = await Promise.all(reachable.map(async ({ url, tip }) => {
    if (Number(tip!.height) === consensusHeight) {
      return { url, hash: String(tip!.hash ?? "") };
    }
    if (Number(tip!.height) < consensusHeight) {
      // Node hasn't synced this height yet — not an opinion either way.
      return { url, hash: null as string | null };
    }
    return { url, hash: await fetchHashAt(url, consensusHeight) };
  }));

  // Step 4: tally hashes. Empty/null hashes don't count as votes.
  const tally = new Map<string, number>();
  for (const { hash } of hashes) {
    if (!hash) continue;
    tally.set(hash, (tally.get(hash) ?? 0) + 1);
  }

  let consensusHash: string | null = null;
  let agreeing = 0;
  for (const [h, n] of tally) {
    if (n > agreeing) { consensusHash = h; agreeing = n; }
  }
  const participants = [...tally.values()].reduce((s, n) => s + n, 0);

  // Require at least MIN_QUORUM participants AND a strict majority before
  // we're willing to call any node "diverged".
  const haveQuorum = participants >= MIN_QUORUM && agreeing * 2 > participants;

  // Build per-node verdicts. Unreachable nodes carry over from the original
  // urls list with diverged=false (we just don't know).
  const reachableMap = new Map(hashes.map((x) => [x.url, x.hash]));
  const tipMap = new Map(tips.map((x) => [x.url, x.tip]));
  const now = Date.now();
  const perNode: NodeConsensus[] = urls.map((url) => {
    const hash = reachableMap.get(url) ?? null;
    const tip = tipMap.get(url) ?? null;
    const diverged = haveQuorum && hash !== null && hash !== consensusHash;
    return {
      url,
      hashAtConsensusHeight: hash,
      reportedTipHeight: tip ? Number(tip.height) : null,
      diverged,
      checkedAt: now,
    };
  });

  return {
    consensusHeight: haveQuorum ? consensusHeight : null,
    consensusHash: haveQuorum ? consensusHash : null,
    agreeing,
    participants,
    perNode,
    checkedAt: now,
  };
}

// Convenience: extract the set of quarantined (diverged) URLs from a snapshot.
export function divergedUrls(snap: ConsensusSnapshot): Set<string> {
  return new Set(snap.perNode.filter((n) => n.diverged).map((n) => n.url));
}

// Stub for environments where we want to suppress the network during tests.
export const __TIP_CONSENSUS_INTERNAL = {
  REORG_DEPTH, MIN_QUORUM, PROBE_TIMEOUT_MS,
};
// Avoid "unused import" warnings if BlobNodeClient becomes unused later.
void BlobNodeClient;
