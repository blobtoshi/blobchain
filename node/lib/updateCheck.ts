// Checks whether the local node checkout is behind the GitHub repo.
// Non-fatal: any failure (offline, not a git checkout, rate-limited) is logged
// and ignored so the node still boots.
//
// Configure via env:
//   UPDATE_REPO          owner/repo on GitHub (default: blobchain/blobchain)
//   UPDATE_BRANCH        branch to track (default: main)
//   UPDATE_CHECK         "0" to disable entirely
//   UPDATE_CHECK_INTERVAL_MS  re-check cadence (default: 6h)

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

const DEFAULT_REPO = process.env.UPDATE_REPO ?? "blobchain/blobchain";
const DEFAULT_BRANCH = process.env.UPDATE_BRANCH ?? "main";
const DEFAULT_INTERVAL_MS = Number(process.env.UPDATE_CHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000);

function getLocalCommit(): string | null {
  try {
    // Walk up from this file to find a .git directory so we work both from
    // /node and from a repo root checkout.
    const here = dirname(fileURLToPath(import.meta.url));
    let dir = here;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, ".git"))) {
        return execSync("git rev-parse HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] })
          .toString().trim();
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

async function getRemoteCommit(repo: string, branch: string): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${repo}/commits/${branch}`;
    const res = await fetch(url, {
      headers: { "Accept": "application/vnd.github+json", "User-Agent": "blobchain-node" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { sha?: string };
    return json.sha ?? null;
  } catch {
    return null;
  }
}

function banner(localShort: string, remoteShort: string, repo: string, branch: string): string {
  const lines = [
    "",
    "════════════════════════════════════════════════════════════════════",
    "  ⚠  A new BLOB CHAIN node release is available.",
    `     Local : ${localShort}`,
    `     Latest: ${remoteShort}  (${repo}@${branch})`,
    "",
    "     Update with:",
    "       git pull && npm install",
    "       # or, if running in Docker:",
    "       docker compose pull && docker compose up -d --build",
    "════════════════════════════════════════════════════════════════════",
    "",
  ];
  return lines.join("\n");
}

async function runOnce(log: Logger): Promise<void> {
  const local = getLocalCommit();
  if (!local) {
    log("info", "update check skipped: not a git checkout");
    return;
  }
  const remote = await getRemoteCommit(DEFAULT_REPO, DEFAULT_BRANCH);
  if (!remote) {
    log("info", "update check skipped: could not reach GitHub");
    return;
  }
  if (remote === local) {
    log("info", "node is up to date", { commit: local.slice(0, 8) });
    return;
  }
  // Local differs from remote tip. We can't cheaply tell ahead-vs-behind from
  // the API alone, but for the published branch this almost always means the
  // operator is behind. Print a clear, hard-to-miss banner.
  const msg = banner(local.slice(0, 8), remote.slice(0, 8), DEFAULT_REPO, DEFAULT_BRANCH);
  // eslint-disable-next-line no-console
  console.log(msg);
  log("warn", "node update available", {
    local: local.slice(0, 8),
    remote: remote.slice(0, 8),
    repo: DEFAULT_REPO,
    branch: DEFAULT_BRANCH,
  });
}

export function startUpdateChecker(log: Logger): void {
  if (process.env.UPDATE_CHECK === "0") {
    log("info", "update check disabled via UPDATE_CHECK=0");
    return;
  }
  // Run shortly after startup so the boot logs land first.
  setTimeout(() => { void runOnce(log); }, 2_000);
  if (DEFAULT_INTERVAL_MS > 0) {
    setInterval(() => { void runOnce(log); }, DEFAULT_INTERVAL_MS).unref();
  }
}
