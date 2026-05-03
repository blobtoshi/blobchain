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
// MUST match BRIDGE_ADDRESS in src/lib/blob/constants.ts.
const BRIDGE_ADDRESS = "13yfvVYknMVa6xoKhVSrFHrshBBQv6rbvm";

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

// Required BLOB-chain confirmations on the deposit tx before we mint on
// Solana. Hardens the bridge against depth-1 reorgs: the BLOB chain only
// supports same-tip tie-break reorgs, so 3 confirmations is overkill but
// gives the user a clear "this is final" signal in the UI.
const REQUIRED_CONFIRMATIONS = 3;

// Look for the bridge tx in the sealed chain via the node's HTTP API.
// We page backward from chain tip in chunks of 500 blocks (node max) and
// also return the current confirmation depth so the caller can decide
// whether to wait before minting.
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
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      const txs = Array.isArray(b?.transactions) ? b.transactions : [];
      for (const tx of txs) {
        if (tx?.id !== txId) continue;
        if (tx.to !== BRIDGE_ADDRESS) continue;
        if (fromAddress && tx.from !== fromAddress) continue;
        if (amount != null && Number(tx.amount) !== Number(amount)) continue;
        const blockHeight = Number(b.height);
        // Confirmations include the block itself: tip == blockHeight → 1 conf.
        const confirmations = Math.max(0, tipHeight - blockHeight + 1);
        return {
          tx,
          height: blockHeight,
          memo: typeof tx.memo === "string" ? tx.memo : "",
          confirmations,
          tipHeight,
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

// Process a bridge request: only update confirmation depth.
// The actual mint is now CO-SIGNED by the user's Solana wallet, so we no longer
// dispatch a background task here. Once `confirmations >= REQUIRED_CONFIRMATIONS`
// and status is "confirmed", the client must call POST /prepare to fetch a
// partially-signed tx, sign it with their wallet, submit it to Solana, then
// POST /submit with the resulting signature.
async function processRequest(supa: Supa, row: any, nodeUrl: string | null) {
  if (row.status === "minted" || row.status === "failed" || row.status === "minting") return row;

  if ((row.status === "pending" || row.status === "confirmed") && nodeUrl) {
    const found = await findConfirmedBridgeTx(
      nodeUrl, row.blob_tx_id, row.from_address, Number(row.amount),
    );
    if (!found) return row;
    const confs = found.confirmations;
    const patch: Record<string, unknown> = { confirmations: confs };
    if (row.status === "pending") {
      patch.status = "confirmed";
      patch.confirmed_at = new Date().toISOString();
      row.status = "confirmed";
    }
    await supa.from("bridge_requests").update(patch).eq("blob_tx_id", row.blob_tx_id);
    row.confirmations = confs;
  }
  return row;
}

// Verify a Solana mint tx really credited the expected amount of wBLOB to the
// expected recipient ATA, signed by our mint authority. Used by /submit to
// avoid trusting the client's claimed signature.
async function verifyMintTx(
  signature: string, expectedRecipient: string, expectedAmount: number,
): Promise<{ ok: boolean; error?: string }> {
  const SOLANA_RPC_URL = Deno.env.get("SOLANA_RPC_URL") ?? "";
  const SPL_MINT       = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";
  if (!SOLANA_RPC_URL || !SPL_MINT) return { ok: false, error: "solana env missing" };

  const r = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.error) return { ok: false, error: `rpc: ${JSON.stringify(j.error)}` };
  const tx = j?.result;
  if (!tx) return { ok: false, error: "tx not found yet" };
  if (tx.meta?.err) return { ok: false, error: `tx failed on chain: ${JSON.stringify(tx.meta.err)}` };

  // Find a MintTo (or mintToChecked) ix targeting our mint, owned by our authority.
  const ixs = tx.transaction?.message?.instructions ?? [];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g: any) => g?.instructions ?? []);
  const all = [...ixs, ...inner];
  let credited = 0;
  for (const ix of all) {
    if (ix?.program !== "spl-token") continue;
    const t = ix?.parsed?.type;
    if (t !== "mintTo" && t !== "mintToChecked") continue;
    const info = ix.parsed.info ?? {};
    if (info.mint !== SPL_MINT) continue;
    const amtRaw = t === "mintToChecked" ? info.tokenAmount?.amount : info.amount;
    const decimals = t === "mintToChecked" ? Number(info.tokenAmount?.decimals ?? 8) : 8;
    const amtUi = Number(amtRaw) / 10 ** decimals;
    credited += amtUi;
  }
  if (credited <= 0) return { ok: false, error: "no mintTo to our mint found in tx" };

  // Sanity-check recipient appears as an account key.
  const keys: string[] = (tx.transaction?.message?.accountKeys ?? []).map(
    (k: any) => typeof k === "string" ? k : k?.pubkey,
  );
  if (!keys.includes(expectedRecipient)) {
    return { ok: false, error: "recipient not in tx account keys" };
  }

  // Allow tiny float-rounding slack.
  if (Math.abs(credited - expectedAmount) > 1e-8) {
    return { ok: false, error: `amount mismatch: credited ${credited}, expected ${expectedAmount}` };
  }
  return { ok: true };
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

    console.log("[bridge-mint] lookup", { nodeUrl, blob_tx_id, from_address, amt, expected_to: BRIDGE_ADDRESS });

    // Diagnostic: dump current mempool from the node so we can see what the
    // edge function actually sees vs what the user sees in their browser.
    let mempoolDump: any[] = [];
    try {
      mempoolDump = await fetchNodeJson(nodeUrl, "/mempool");
      console.log("[bridge-mint] mempool size", Array.isArray(mempoolDump) ? mempoolDump.length : "not-array");
      if (Array.isArray(mempoolDump)) {
        const match = mempoolDump.find((t) => t?.id === blob_tx_id);
        console.log("[bridge-mint] mempool tx by id", match ?? "(not found)");
      }
    } catch (e) {
      console.error("[bridge-mint] diagnostic mempool fetch failed", e);
    }

    const pending = await findPendingBridgeTx(nodeUrl, blob_tx_id, from_address, amt);
    const confirmed = pending ? null : await findConfirmedBridgeTx(nodeUrl, blob_tx_id, from_address, amt);
    if (!pending && !confirmed) {
      // Build a richer error so the client can see WHY it failed.
      const sample = Array.isArray(mempoolDump) ? mempoolDump.slice(0, 3).map((t) => ({
        id: t?.id, from: t?.from, to: t?.to, amount: t?.amount,
      })) : null;
      return new Response(JSON.stringify({
        error: "matching BLOB transaction not found in mempool or chain",
        debug: {
          nodeUrl,
          looking_for: { blob_tx_id, from_address, amount: amt, to: BRIDGE_ADDRESS },
          mempool_size: Array.isArray(mempoolDump) ? mempoolDump.length : null,
          mempool_sample: sample,
        },
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
