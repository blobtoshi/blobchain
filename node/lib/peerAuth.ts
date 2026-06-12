// H1: peer dial allowlist, private-IP-range blocking, and a signed peer
// handshake. The full node used to dial ANY URL handed to it via peerIdentify
// and then ingest blocks from it — an SSRF / eclipse primitive and the remote
// trigger for the consensus flaws (C1/C2). This module is the gate:
//
//   • parseAllowlist / hostAllowed — only operator-listed hosts may be dialed
//     or trusted (PEER_ALLOWLIST env; bootstrap PEERS hosts are auto-added).
//   • isPrivateHost — never dial loopback / RFC1918 / link-local / ULA / the
//     cloud metadata IP, even if some allowlist entry resolves there.
//   • signHandshake / verifyHandshake — HMAC-SHA256 over (nodeId|ts|nonce)
//     using the shared NODE_KEY, with a ±freshness window, so a peer must
//     prove key possession before we ingest its blocks.
//
// No secret is hardcoded: NODE_KEY and PEER_ALLOWLIST come from env.

import { createHmac, timingSafeEqual } from "node:crypto";

export type PeerAuth = { nodeId: string; ts: number; nonce: string; sig: string };

const HANDSHAKE_SKEW_MS = 120_000; // ±2 min freshness window

/** Extract a lowercase hostname from a URL or host[:port] string. */
export function hostOf(raw: string): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  try {
    if (/^[a-z]+:\/\//i.test(t)) return new URL(t).hostname.toLowerCase();
    // host[:port] form — wrap so URL() can parse it.
    return new URL(`ws://${t}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Parse PEER_ALLOWLIST (comma/space separated URLs or host[:port]) into a set of hostnames. */
export function parseAllowlist(raw: string | undefined | null): Set<string> {
  const set = new Set<string>();
  for (const part of String(raw ?? "").split(/[,\s]+/)) {
    const h = hostOf(part);
    if (h) set.add(h);
  }
  return set;
}

/** Is this host a private / loopback / link-local / metadata address we must never dial? */
export function isPrivateHost(host: string): boolean {
  const h = (host ?? "").toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;

  // IPv6 loopback / link-local / unique-local.
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 unique-local
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — fall through to the v4 check below.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped ? mapped[1] : h;

  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return true; // malformed → reject
    const [a, b] = o;
    if (a === 0) return true;                         // 0.0.0.0/8
    if (a === 10) return true;                        // 10.0.0.0/8
    if (a === 127) return true;                       // loopback
    if (a === 169 && b === 254) return true;          // link-local + metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;// 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                        // multicast / reserved
  }
  return false;
}

/**
 * May we dial / trust this URL? Allowed iff its host is in the allowlist and is
 * not a private/loopback/metadata address. An empty allowlist allows nothing
 * (secure default) — operators must opt peers in explicitly.
 */
export function hostAllowed(rawUrl: string, allow: Set<string>): boolean {
  const h = hostOf(rawUrl);
  if (!h) return false;
  if (isPrivateHost(h)) return false;
  return allow.has(h);
}

/** HMAC-SHA256(nodeKey, `${nodeId}|${ts}|${nonce}`) as hex. */
export function signHandshake(nodeKey: string, nodeId: string, ts: number, nonce: string): string {
  return createHmac("sha256", nodeKey).update(`${nodeId}|${ts}|${nonce}`).digest("hex");
}

/** Build a fresh auth token for this node. */
export function makeAuth(nodeKey: string, nodeId: string): PeerAuth {
  const ts = Date.now();
  const nonce = Math.random().toString(16).slice(2) + Date.now().toString(16);
  return { nodeId, ts, nonce, sig: signHandshake(nodeKey, nodeId, ts, nonce) };
}

/** Verify a peer's auth token against the shared key with a freshness window. */
export function verifyHandshake(nodeKey: string, auth: PeerAuth | undefined | null): boolean {
  if (!nodeKey || !auth || typeof auth !== "object") return false;
  const { nodeId, ts, nonce, sig } = auth;
  if (typeof nodeId !== "string" || typeof nonce !== "string" || typeof sig !== "string") return false;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() - ts) > HANDSHAKE_SKEW_MS) return false;
  const expected = signHandshake(nodeKey, nodeId, ts, nonce);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(sig), "utf8");
  if (a.length !== b.length) return false;
  try { return timingSafeEqual(a, b); } catch { return false; }
}
