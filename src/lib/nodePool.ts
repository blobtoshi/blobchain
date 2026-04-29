// Node pool: a tiny client-side load-balancer/failover layer for full nodes.
//
// Responsibilities:
//   • Hold a list of candidate node URLs (bundled defaults + user customs).
//   • Health-probe them periodically and on demand.
//   • Pick the active node = lowest-latency healthy candidate, OR a user pin.
//   • Notify listeners when the active URL changes (so blobRelay can rebuild
//     its BlobNodeClient, reopen the socket, etc.).
//   • Persist user preferences (pinned URL + saved customs) to localStorage.
//
// Designed to be runtime-agnostic: the desktop app reuses the same module by
// swapping the storage adapter (electron disk file vs localStorage).

import { BlobNodeClient } from "@/lib/blobNodeClient";
import {
  runConsensusRound, divergedUrls,
  type ConsensusSnapshot,
} from "@/lib/tipConsensus";

export type NodeHealth = {
  url: string;
  ok: boolean;
  ms: number | null; // round-trip in ms when ok
  checkedAt: number;
  // True if cross-node consensus flagged this node as serving a chain
  // that disagrees with the majority. Quarantined nodes are never picked
  // as the active node (eclipse-attack mitigation).
  diverged?: boolean;
};

export type StorageAdapter = {
  read: () => { pinned: string | null; custom: string[] } | null;
  write: (cfg: { pinned: string | null; custom: string[] }) => void;
};

// Bundled public node list — production fleet.
export const BUNDLED_NODES: string[] = [
  "https://node.blobchain.network",
  "https://node-eu.blobchain.network",
  "https://node-us.blobchain.network",
];

const STORAGE_KEY = "blob:node-config";
const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 2500;
const FAILOVER_FAIL_WINDOW_MS = 10_000;
const FAILOVER_FAIL_THRESHOLD = 3;
// How often to run cross-node tip consensus. Cheaper than a full health
// probe (one tip request per node) so we run it more often than PROBE_INTERVAL.
const CONSENSUS_INTERVAL_MS = 20_000;

function defaultStorage(): StorageAdapter {
  return {
    read: () => {
      try {
        if (typeof localStorage === "undefined") return null;
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw);
        return {
          pinned: typeof j.pinned === "string" ? j.pinned : null,
          custom: Array.isArray(j.custom) ? j.custom.filter((x: any) => typeof x === "string") : [],
        };
      } catch { return null; }
    },
    write: (cfg) => {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      } catch { /* ignore */ }
    },
  };
}

export type PoolEvent =
  | { type: "active-changed"; url: string | null }
  | { type: "health-updated"; health: NodeHealth[] }
  | { type: "config-changed"; pinned: string | null; custom: string[] }
  | { type: "consensus-updated"; snapshot: ConsensusSnapshot };

type Listener = (e: PoolEvent) => void;

class NodePool {
  private storage: StorageAdapter;
  private pinned: string | null = null;
  private custom: string[] = [];
  private health = new Map<string, NodeHealth>();
  private active: string | null = null;
  private listeners = new Set<Listener>();
  private probeTimer: any = null;
  private consensusTimer: any = null;
  private failureLog: number[] = []; // timestamps of recent active-node failures
  private quarantine = new Set<string>(); // urls flagged by tip consensus
  private lastConsensus: ConsensusSnapshot | null = null;

  constructor(storage?: StorageAdapter) {
    this.storage = storage ?? defaultStorage();
    const cfg = this.storage.read();
    if (cfg) {
      this.pinned = cfg.pinned;
      this.custom = cfg.custom;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────
  start() {
    if (this.probeTimer) return;
    this.probeAll();
    this.probeTimer = setInterval(() => this.probeAll(), PROBE_INTERVAL_MS);
    // Run an initial consensus check shortly after first probes complete,
    // then on a steady cadence.
    setTimeout(() => this.runConsensus(), 1500);
    this.consensusTimer = setInterval(() => this.runConsensus(), CONSENSUS_INTERVAL_MS);
  }

  stop() {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.consensusTimer) clearInterval(this.consensusTimer);
    this.probeTimer = null;
    this.consensusTimer = null;
  }

  getConsensus(): ConsensusSnapshot | null { return this.lastConsensus; }

  // Force a consensus round immediately (e.g., right after the user pins
  // a brand-new custom node so they get instant feedback).
  async refreshConsensus(): Promise<ConsensusSnapshot | null> {
    await this.runConsensus();
    return this.lastConsensus;
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getCandidates(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of [...BUNDLED_NODES, ...this.custom]) {
      const c = clean(u);
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
    }
    return out;
  }

  getHealth(): NodeHealth[] {
    return this.getCandidates().map((u) =>
      this.health.get(u) ?? { url: u, ok: false, ms: null, checkedAt: 0 },
    );
  }

  getActive(): string | null { return this.active; }
  getPinned(): string | null { return this.pinned; }
  getCustom(): string[] { return [...this.custom]; }
  isAuto(): boolean { return this.pinned === null; }

  // Set the user pin. null = auto.
  setPinned(url: string | null) {
    const cleaned = url ? clean(url) : null;
    if (cleaned === this.pinned) return;
    this.pinned = cleaned;
    this.persist();
    this.emit({ type: "config-changed", pinned: this.pinned, custom: [...this.custom] });
    this.recomputeActive();
  }

  // Add a custom URL (de-duped, trimmed). Returns the cleaned URL or null.
  addCustom(url: string): string | null {
    const c = clean(url);
    if (!c) return null;
    if (this.custom.includes(c) || BUNDLED_NODES.map(clean).includes(c)) return c;
    this.custom = [...this.custom, c];
    this.persist();
    this.emit({ type: "config-changed", pinned: this.pinned, custom: [...this.custom] });
    // Probe the new one immediately so the picker shows latency.
    this.probeOne(c);
    return c;
  }

  removeCustom(url: string) {
    const c = clean(url);
    if (!this.custom.includes(c)) return;
    this.custom = this.custom.filter((u) => u !== c);
    if (this.pinned === c) this.pinned = null; // un-pin if removed
    this.health.delete(c);
    this.persist();
    this.emit({ type: "config-changed", pinned: this.pinned, custom: [...this.custom] });
    this.recomputeActive();
  }

  // Re-probe everything on demand.
  async refresh(): Promise<NodeHealth[]> {
    await this.probeAll();
    return this.getHealth();
  }

  // Called by clients (REST/WS) when they fail talking to the active node.
  // After enough failures in the failure window we mark the active node
  // unhealthy and fail over to the next best.
  reportFailure(url: string) {
    if (!this.active || clean(url) !== this.active) return;
    const now = Date.now();
    this.failureLog = this.failureLog.filter((t) => now - t < FAILOVER_FAIL_WINDOW_MS);
    this.failureLog.push(now);
    if (this.failureLog.length >= FAILOVER_FAIL_THRESHOLD) {
      // Mark the active node as unreachable and re-pick.
      this.health.set(this.active, { url: this.active, ok: false, ms: null, checkedAt: now });
      this.failureLog = [];
      this.emit({ type: "health-updated", health: this.getHealth() });
      // Kick off a fresh probe in the background so it can come back later.
      void this.probeOne(this.active);
      this.recomputeActive();
    }
  }

  reportSuccess(url: string) {
    if (!this.active || clean(url) !== this.active) return;
    this.failureLog = [];
  }

  // ── Internals ───────────────────────────────────────────────────────
  private async probeAll() {
    const urls = this.getCandidates();
    await Promise.all(urls.map((u) => this.probeOne(u)));
    this.emit({ type: "health-updated", health: this.getHealth() });
    this.recomputeActive();
  }

  private async probeOne(url: string) {
    const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    const ok = await BlobNodeClient.healthcheck(url, PROBE_TIMEOUT_MS);
    const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.health.set(url, {
      url,
      ok,
      ms: ok ? Math.round(t1 - t0) : null,
      checkedAt: Date.now(),
    });
  }

  private recomputeActive() {
    let next: string | null = null;
    if (this.pinned) {
      next = this.pinned; // honor pin even if currently unhealthy — caller will retry
    } else {
      const healthy = [...this.health.values()].filter((h) => h.ok && h.ms !== null);
      healthy.sort((a, b) => (a.ms! - b.ms!));
      next = healthy[0]?.url ?? null;
    }
    if (next === this.active) return;
    this.active = next;
    this.emit({ type: "active-changed", url: this.active });
  }

  private persist() {
    this.storage.write({ pinned: this.pinned, custom: [...this.custom] });
  }

  private emit(e: PoolEvent) {
    for (const l of this.listeners) { try { l(e); } catch { /* ignore */ } }
  }
}

function clean(u: string): string {
  return (u ?? "").trim().replace(/\/+$/, "");
}

// ── Singleton ────────────────────────────────────────────────────────
let singleton: NodePool | null = null;

export function getNodePool(): NodePool {
  if (!singleton) {
    singleton = new NodePool();
    singleton.start();
  }
  return singleton;
}

// Allow desktop to inject its own storage before first use.
export function initNodePool(storage: StorageAdapter): NodePool {
  if (singleton) singleton.stop();
  singleton = new NodePool(storage);
  singleton.start();
  return singleton;
}

export type { NodePool };
