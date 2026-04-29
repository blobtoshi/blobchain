// Bridge $BLOB → Solana SPL.
//
// Flow (happy path):
//   1. Client signs a normal $BLOB tx to BRIDGE_ADDRESS with memo `sol:<sol_address>`
//      and broadcasts it via submit-tx (mempool).
//   2. Client POSTs here with { blob_tx_id, sol_address, amount, from_address }.
//      → We verify the tx is in mempool OR already sealed, **always** insert a
//        bridge_requests row (so coins can never be "missing"), then dispatch
//        the mint as a background task.
//   3. Once the originating tx lands in a sealed block, we mint exactly `amount`
//      SPL tokens to the recipient SOL address using the configured mint
//      authority and mark the request `minted` with the Solana signature.
//   4. GET ?blob_tx_id=... polls status (and re-attempts mint if needed).
//
// Recovery path:
//   POST /recover { blob_tx_id } — for txs that were sealed on-chain but never
//   got a bridge_requests row (e.g. the original POST failed). We re-derive
//   sol_address / amount / from_address from the on-chain tx itself, so this
//   is safe and idempotent.
//
// Audit path:
//   GET /audit — returns total locked / minted / unreconciled BLOB across the
//   whole bridge. This is the bridge solvency proof.
//
// IMPORTANT: heavy Solana SDK imports are loaded LAZILY inside mintSpl() to
// keep cold-start CPU under the edge runtime budget.

import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;

// NOTE: This function is intentionally lean — no Solana SDK imports — so it
// stays well under the edge runtime's per-request CPU budget. The actual SPL
// mint is performed by the separate `bridge-execute-mint` function, which we
// invoke via fetch() once a bridge tx is confirmed on-chain. Splitting the
// work this way gives each step its own CPU budget.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Bridge deposit address on Blob Chain.
// MUST match GENESIS.bridgeAddress in src/lib/blob/constants.ts (pinned at genesis).
const BRIDGE_ADDRESS = "1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs";

const SOLANA_SPL_MINT_ADDRESS = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";

const SOL_ADDR_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BLOB_ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const TX_ID_RE     = /^[0-9a-fA-F]{8,64}$/;

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function ok_(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
const safeParse = (s: unknown, fb: unknown) => {
  try { return typeof s === "string" ? JSON.parse(s) : (s ?? fb); } catch { return fb; }
};

type Supa = ReturnType<typeof createClient>;

// ── Node HTTP API helpers ──────────────────────────────────────────────
// We query the user's full-node HTTP API directly (mempool + sealed blocks)
// instead of mirroring chain state into Supabase tables. Callers must pass
// `node_url` (e.g. a cloudflared tunnel URL) so the edge function knows
// where to look. Localhost is allowed for local dev only.
function sanitizeNodeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  let u: URL;
  try { u = new URL(trimmed); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  // Block obvious SSRF surfaces. http:// only allowed for localhost dev.
  if (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) {
    return null;
  }
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

async function fetchNodeJson(nodeUrl: string, path: string): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${nodeUrl}${path}`, { signal: ac.signal });
    if (!r.ok) throw new Error(`node ${path} ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Look for the bridge tx in the sealed chain via the node's HTTP API.
// We page backward from chain tip in chunks of 500 blocks (node max).
async function findConfirmedBridgeTx(
  nodeUrl: string,
  txId: string,
  fromAddress: string | null,
  amount: number | null,
) {
  let tipHeight: number;
  try {
    const tip = await fetchNodeJson(nodeUrl, "/chain/tip");
    tipHeight = Number(tip?.height ?? 0);
  } catch (e) {
    console.error("[bridge-mint] /chain/tip failed", e);
    return null;
  }
  if (!Number.isFinite(tipHeight) || tipHeight <= 0) return null;

  const PAGE = 500;
  // Scan most-recent blocks first; cap total scan at 5000 blocks for safety.
  const MAX_SCAN = 5000;
  let end = tipHeight;
  let scanned = 0;
  while (end >= 1 && scanned < MAX_SCAN) {
    const from = Math.max(1, end - PAGE + 1);
    let blocks: any[] = [];
    try {
      blocks = await fetchNodeJson(nodeUrl, `/blocks?from=${from}&limit=${end - from + 1}`);
    } catch (e) {
      console.error("[bridge-mint] /blocks failed", e);
      return null;
    }
    // Iterate newest-first within the page
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const txs = Array.isArray(b?.transactions) ? b.transactions : [];
      for (const tx of txs) {
        if (tx?.id !== txId) continue;
        if (tx.to !== BRIDGE_ADDRESS) continue;
        if (fromAddress && tx.from !== fromAddress) continue;
        if (amount != null && Number(tx.amount) !== Number(amount)) continue;
        return {
          tx,
          height: Number(b.height),
          memo: typeof tx.memo === "string" ? tx.memo : "",
        };
      }
    }
    scanned += (end - from + 1);
    end = from - 1;
  }
  return null;
}

function extractSolFromMemo(memo: unknown): string {
  if (typeof memo !== "string") return "";
  const m = memo.match(/^sol:([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  return m ? m[1] : "";
}

async function findPendingBridgeTx(
  nodeUrl: string,
  txId: string,
  fromAddress: string,
  amount: number,
) {
  let mempool: any[] = [];
  try {
    mempool = await fetchNodeJson(nodeUrl, "/mempool");
  } catch (e) {
    console.error("[bridge-mint] /mempool failed", e);
    return null;
  }
  if (!Array.isArray(mempool)) return null;
  const tx = mempool.find((t) => t?.id === txId);
  if (!tx) return null;
  if (tx.from !== fromAddress) return null;
  if (tx.to !== BRIDGE_ADDRESS) return null;
  if (Number(tx.amount) !== Number(amount)) return null;
  return { id: tx.id, from_address: tx.from, to_address: tx.to, amount: tx.amount, memo: tx.memo };
}

// Delegate the heavy SPL mint to a dedicated function so each step gets its
// own per-request CPU budget. Returns the Solana tx signature.
async function mintSpl(recipient: string, amount: number): Promise<string> {
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error("supabase env missing");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/bridge-execute-mint`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "apikey": SERVICE_KEY,
    },
    body: JSON.stringify({ recipient, amount }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json?.signature) {
    throw new Error(json?.error || `bridge-execute-mint failed (${res.status})`);
  }
  return json.signature as string;
}

async function backgroundMint(
  supa: Supa, blob_tx_id: string, sol_address: string, amount: number,
) {
  try {
    const sig = await mintSpl(sol_address, amount);
    await supa.from("bridge_requests").update({
      status: "minted",
      sol_signature: sig,
      minted_at: new Date().toISOString(),
      error: null,
    }).eq("blob_tx_id", blob_tx_id);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error("[bridge-mint] mint failed", blob_tx_id, msg);
    await supa.from("bridge_requests")
      .update({ status: "confirmed", error: msg })
      .eq("blob_tx_id", blob_tx_id);
  }
}

// Process a bridge request: confirm originating tx, then dispatch the mint as
// a background task. Idempotent. If `nodeUrl` is null we skip the chain
// re-check (used by GET poll when client didn't pass a node_url) — minting
// still proceeds for rows already marked confirmed.
async function processRequest(supa: Supa, row: any, nodeUrl: string | null) {
  if (row.status === "minted" || row.status === "failed" || row.status === "minting") return row;

  if (row.status === "pending") {
    if (!nodeUrl) return row; // need a node to confirm; caller will retry
    const confirmed = await findConfirmedBridgeTx(
      nodeUrl, row.blob_tx_id, row.from_address, Number(row.amount),
    );
    if (!confirmed) return row;
    await supa.from("bridge_requests").update({
      status: "confirmed",
      confirmed_at: new Date().toISOString(),
    }).eq("blob_tx_id", row.blob_tx_id);
    row.status = "confirmed";
  }

  const { data: claimed } = await supa.from("bridge_requests")
    .update({ status: "minting" })
    .eq("blob_tx_id", row.blob_tx_id)
    .eq("status", "confirmed")
    .select().maybeSingle();
  if (!claimed) {
    const { data: latest } = await supa.from("bridge_requests")
      .select("*").eq("blob_tx_id", row.blob_tx_id).maybeSingle();
    return latest ?? row;
  }

  await backgroundMint(supa, row.blob_tx_id, row.sol_address, Number(row.amount));
  const { data: latest } = await supa.from("bridge_requests")
    .select("*").eq("blob_tx_id", row.blob_tx_id).maybeSingle();
  return latest ?? claimed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const url = new URL(req.url);

  // Public config
  if (req.method === "GET" && url.pathname.endsWith("/config")) {
    return ok_({
      bridgeAddress: BRIDGE_ADDRESS,
      splMintAddress: SOLANA_SPL_MINT_ADDRESS || null,
    });
  }

  // Bridge solvency proof
  if (req.method === "GET" && url.pathname.endsWith("/audit")) {
    const { data, error } = await supa.from("bridge_audit").select("*").maybeSingle();
    if (error) return bad("audit failed", 500);
    return ok_(data ?? {
      total_locked_blob: 0, total_minted_blob: 0,
      unreconciled_blob: 0, unreconciled_count: 0, total_bridge_txs: 0,
    });
  }

  // Recovery: rebuild a bridge_requests row from on-chain data alone.
  if (req.method === "POST" && url.pathname.endsWith("/recover")) {
    try {
      const body = (await req.json()) ?? {};
      const { blob_tx_id, node_url } = body;
      if (typeof blob_tx_id !== "string" || !TX_ID_RE.test(blob_tx_id)) {
        return bad("invalid blob_tx_id");
      }
      const nodeUrl = sanitizeNodeUrl(node_url);
      if (!nodeUrl) return bad("invalid or missing node_url");

      const found = await findConfirmedBridgeTx(nodeUrl, blob_tx_id, null, null);
      if (!found) return bad("tx not found in chain", 404);

      const memoSol = extractSolFromMemo(found.memo);
      if (!memoSol) return bad("on-chain tx has no sol: memo");

      const amt = Number(found.tx.amount);
      const fromAddress = String(found.tx.from);

      const { data: existing } = await supa.from("bridge_requests")
        .select("*").eq("blob_tx_id", blob_tx_id).maybeSingle();

      let row = existing;
      if (!row) {
        const { data: inserted, error: insErr } = await supa.from("bridge_requests")
          .insert({
            blob_tx_id,
            from_address: fromAddress,
            sol_address: memoSol,
            amount: amt,
            status: "confirmed",
            confirmed_at: new Date().toISOString(),
          }).select().single();
        if (insErr) {
          console.error("[bridge-mint/recover] insert failed", insErr);
          return bad("internal error", 500);
        }
        row = inserted;
      } else if (row.status === "failed" || row.status === "pending") {
        const { data: upd } = await supa.from("bridge_requests")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString(), error: null })
          .eq("blob_tx_id", blob_tx_id).select().single();
        row = upd ?? row;
      }
      const updated = await processRequest(supa, row, nodeUrl);
      return ok_(updated);
    } catch (e) {
      console.error("[bridge-mint/recover] error", e);
      return bad("internal error", 500);
    }
  }

  // GET ?blob_tx_id=...&node_url=... → status, attempt mint if ready
  if (req.method === "GET") {
    const txId = url.searchParams.get("blob_tx_id") ?? "";
    if (!TX_ID_RE.test(txId)) return bad("invalid blob_tx_id");
    const nodeUrl = sanitizeNodeUrl(url.searchParams.get("node_url"));
    const { data: row } = await supa.from("bridge_requests")
      .select("*").eq("blob_tx_id", txId).maybeSingle();
    if (!row) return bad("not found", 404);
    const updated = await processRequest(supa, row, nodeUrl);
    return ok_(updated);
  }

  if (req.method !== "POST") return bad("method not allowed", 405);

  try {
    const body = await req.json();
    const { blob_tx_id, sol_address, amount, from_address, node_url } = body ?? {};

    if (typeof blob_tx_id !== "string" || !TX_ID_RE.test(blob_tx_id))
      return bad("invalid blob_tx_id");
    if (typeof sol_address !== "string" || !SOL_ADDR_RE.test(sol_address))
      return bad("invalid sol_address");
    if (typeof from_address !== "string" || !BLOB_ADDR_RE.test(from_address))
      return bad("invalid from_address");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000)
      return bad("invalid amount");
    const nodeUrl = sanitizeNodeUrl(node_url);
    if (!nodeUrl) return bad("invalid or missing node_url");

    const pending = await findPendingBridgeTx(nodeUrl, blob_tx_id, from_address, amt);
    const confirmed = pending ? null : await findConfirmedBridgeTx(nodeUrl, blob_tx_id, from_address, amt);
    if (!pending && !confirmed) {
      return bad("matching BLOB transaction not found in mempool or chain");
    }

    const memoSol = extractSolFromMemo(pending ? (pending as any).memo : (confirmed as any).memo);
    if (!memoSol) return bad("originating tx is missing a valid sol: memo");
    if (memoSol !== sol_address) return bad("sol_address does not match tx memo");

    // ALWAYS create the row first (idempotent on blob_tx_id) so locked coins
    // are never invisible to the bridge.
    const { data: existing } = await supa.from("bridge_requests")
      .select("*").eq("blob_tx_id", blob_tx_id).maybeSingle();

    let row = existing;
    if (!row) {
      const { data: inserted, error: insErr } = await supa.from("bridge_requests")
        .insert({
          blob_tx_id,
          from_address,
          sol_address,
          amount: amt,
          status: confirmed ? "confirmed" : "pending",
          confirmed_at: confirmed ? new Date().toISOString() : null,
        }).select().single();
      if (insErr) {
        console.error("[bridge-mint] request insert failed", insErr);
        return bad("internal error", 500);
      }
      row = inserted;
    }

    const updated = await processRequest(supa, row, nodeUrl);
    return ok_(updated);
  } catch (e) {
    console.error("[bridge-mint] unexpected error", e);
    return bad("internal error", 500);
  }
});
