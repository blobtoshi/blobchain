// Bridge $BLOB → Solana SPL  (SOL-fee-gated auto-mint)
//
// Flow:
//   1. Client checks if recipient already has a WBLOB ATA on Solana.
//   2. Client sends a SOL transfer to the MINT AUTHORITY address covering:
//        • ATA rent (~0.00204 SOL)  if the ATA doesn't exist yet
//        • tx signature fee (~0.000005 SOL)  always
//      This transaction's signature is stored as sol_signature on the row.
//   3. Client broadcasts a BLOB tx to BRIDGE_ADDRESS with memo `sol:<addr>`,
//      then POSTs here with { blob_tx_id, sol_address, amount, from_address,
//      sol_signature, node_url }.
//   4. Each GET poll calls processRequest().  Once the BLOB tx has
//      REQUIRED_CONFIRMATIONS AND the SOL fee tx is confirmed on-chain,
//      it atomically claims the row and dispatches bridge-execute-mint.
//   5. bridge-execute-mint signs + broadcasts the SPL mint using mint
//      authority as sole signer/fee-payer (funded by the user's SOL payment)
//      and returns the Solana signature.  We overwrite sol_signature and
//      mark the row minted.
//
// sol_signature lifecycle:
//   pending / confirmed / minting  →  SOL fee payment tx signature
//   minted                         →  WBLOB mint tx signature (overwritten)
//
// Recovery:  POST /recover { blob_tx_id, node_url }
// Audit:     GET  /audit

import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import bs58 from "https://esm.sh/bs58@5.0.0";
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;

const SUPABASE_URL            = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY             = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SOLANA_RPC_URL          = Deno.env.get("SOLANA_RPC_URL") ?? "";
const SOLANA_SPL_MINT_ADDRESS = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

<<<<<<< HEAD
const BRIDGE_ADDRESS = "19xGuoUEng3w4Y2DjP6te2LLTSKt7fKs27";
=======
// Bridge deposit address on Blob Chain.
// MUST match BRIDGE_ADDRESS in src/lib/blob/constants.ts.
const BRIDGE_ADDRESS = "1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs";
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

// Derive mint authority pubkey from the 64-byte secret key env var.
// Supports JSON byte-array "[0,1,...,63]" and base58-encoded formats.
const MINT_AUTHORITY_PUBKEY: string = (() => {
  const raw = Deno.env.get("SOLANA_MINT_AUTHORITY_SECRET_KEY") ?? "";
  if (!raw.trim()) {
    console.warn("[bridge-mint] SOLANA_MINT_AUTHORITY_SECRET_KEY not set");
    return "";
  }
  try {
    const secret = raw.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(raw.trim()))
      : bs58.decode(raw.trim());
    if (secret.length !== 64) {
      console.error(`[bridge-mint] secret key must be 64 bytes (got ${secret.length})`);
      return "";
    }
    return bs58.encode(secret.slice(32, 64));
  } catch (e) {
    console.error("[bridge-mint] failed to derive mint authority pubkey:", e);
    return "";
  }
})();

// Startup banner so Supabase logs make the deployed config obvious.  Compare
// MINT_AUTHORITY_PUBKEY against the on-chain mint authority (visible on
// solscan under the WBLOB mint's "Mint Authority" field) — they MUST match
// or no SOL fee payment will ever verify.
console.log("[bridge-mint] startup", {
  mint_authority_pubkey: MINT_AUTHORITY_PUBKEY || "(not derived — secret key missing or malformed)",
  solana_rpc_url:        SOLANA_RPC_URL ? new URL(SOLANA_RPC_URL).host : "(not set)",
  spl_mint_address:      SOLANA_SPL_MINT_ADDRESS || "(not set)",
  bridge_address:        BRIDGE_ADDRESS,
});

const SOL_ADDR_RE  = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BLOB_ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const TX_ID_RE     = /^[0-9a-fA-F]{8,64}$/;
const SOL_SIG_RE   = /^[1-9A-HJ-NP-Za-km-z]{80,128}$/;

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

type Supa = ReturnType<typeof createClient>;

// ── Node helpers ─────────────────────────────────────────────────────────────

function sanitizeNodeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/\/+$/, "");
  if (!t) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/i.test(u.hostname)) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

async function fetchNodeJson(nodeUrl: string, path: string): Promise<any> {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${nodeUrl}${path}`, { signal: ac.signal });
    if (!r.ok) throw new Error(`node ${path} → ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

const REQUIRED_CONFIRMATIONS = 3;

async function findConfirmedBridgeTx(
  nodeUrl: string, txId: string,
  fromAddress: string | null, amount: number | null,
) {
  let tipHeight: number;
  try {
    const tip = await fetchNodeJson(nodeUrl, "/chain/tip");
    tipHeight = Number(tip?.height ?? 0);
  } catch (e) { console.error("[bridge-mint] /chain/tip failed", e); return null; }
  if (!Number.isFinite(tipHeight) || tipHeight <= 0) return null;

  const PAGE = 500, MAX_SCAN = 5000;
  let end = tipHeight, scanned = 0;
  while (end >= 1 && scanned < MAX_SCAN) {
    const from = Math.max(1, end - PAGE + 1);
    let blocks: any[] = [];
    try { blocks = await fetchNodeJson(nodeUrl, `/blocks?from=${from}&limit=${end - from + 1}`); }
    catch (e) { console.error("[bridge-mint] /blocks failed", e); return null; }
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b   = blocks[i];
      const txs = Array.isArray(b?.transactions) ? b.transactions : [];
      for (const tx of txs) {
        if (tx?.id !== txId || tx.to !== BRIDGE_ADDRESS) continue;
        if (fromAddress && tx.from !== fromAddress) continue;
        if (amount != null && Number(tx.amount) !== Number(amount)) continue;
        const blockHeight   = Number(b.height);
        const confirmations = Math.max(0, tipHeight - blockHeight + 1);
        return { tx, height: blockHeight, memo: typeof tx.memo === "string" ? tx.memo : "", confirmations, tipHeight };
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
  nodeUrl: string, txId: string, fromAddress: string, amount: number,
) {
  let mempool: any[] = [];
  try { mempool = await fetchNodeJson(nodeUrl, "/mempool"); }
  catch (e) { console.error("[bridge-mint] /mempool failed", e); return null; }
  if (!Array.isArray(mempool)) return null;
  const tx = mempool.find((t) => t?.id === txId);
  if (!tx || tx.from !== fromAddress || tx.to !== BRIDGE_ADDRESS) return null;
  if (Number(tx.amount) !== Number(amount)) return null;
  return { id: tx.id, from_address: tx.from, to_address: tx.to, amount: tx.amount, memo: tx.memo };
}

// ── SOL fee payment verification ─────────────────────────────────────────────
// Returns { ok: false, pending: true } while the tx is still in flight so
// processRequest() retries on the next poll instead of failing the request.

async function verifySolPayment(
  signature: string,
  fromAddress: string,
): Promise<{ ok: boolean; pending?: boolean; error?: string; debug?: any }> {
  if (!SOLANA_RPC_URL)          return { ok: false, error: "SOLANA_RPC_URL not configured" };
  if (!MINT_AUTHORITY_PUBKEY)   return { ok: false, error: "mint authority pubkey not available — check SOLANA_MINT_AUTHORITY_SECRET_KEY" };

  let resp: Response;
  try {
    resp = await fetch(SOLANA_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "getTransaction",
        params: [signature, {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        }],
      }),
    });
  } catch (e) {
    return { ok: false, pending: true, error: `Solana RPC unreachable: ${(e as Error)?.message}` };
  }

  const j = await resp.json().catch(() => ({}));
  if (j?.error) return { ok: false, error: `RPC error: ${JSON.stringify(j.error)}` };

  const tx = j?.result;
  if (tx === null || tx === undefined) {
    // getTransaction returns null when not yet visible at this commitment level
    return { ok: false, pending: true, error: "SOL fee tx not confirmed yet — will retry" };
  }
  if (tx.meta?.err) {
    return { ok: false, error: `SOL fee tx failed on chain: ${JSON.stringify(tx.meta.err)}` };
  }

  // Sum all system-program Transfer ixs from user → mint authority.
  // Wallets sometimes prepend ComputeBudget ixs (priority fees) and the
  // jsonParsed encoding will surface those alongside our transfer.
  const ixs: any[] = tx.transaction?.message?.instructions ?? [];
  let totalLamports = 0;
  const seenTransfers: any[] = [];
  for (const ix of ixs) {
    if (ix?.program !== "system" || ix?.parsed?.type !== "transfer") continue;
    const info = ix.parsed?.info ?? {};
    seenTransfers.push({
      source:      info.source,
      destination: info.destination,
      lamports:    info.lamports,
    });
    if (info.source !== fromAddress)                continue;
    if (info.destination !== MINT_AUTHORITY_PUBKEY) continue;
    totalLamports += Number(info.lamports ?? 0);
  }

  // Minimum: at least one tx fee's worth so dust-spam is uneconomical
  const MIN_LAMPORTS = 5_000;
  if (totalLamports < MIN_LAMPORTS) {
    // Verbose log + debug payload so /debug?blob_tx_id=… returns enough info
    // to see exactly what the on-chain tx looked like vs what we expected.
    const debug = {
      signature,
      expected_from:        fromAddress,
      expected_to:          MINT_AUTHORITY_PUBKEY,
      total_lamports_found: totalLamports,
      transfers_in_tx:      seenTransfers,
      instruction_count:    ixs.length,
      programs_in_tx:       [...new Set(ixs.map((i) => i?.program ?? "(unknown)"))],
    };
    console.log("[verifySolPayment] no matching transfer", debug);
    return {
      ok: false,
      error: totalLamports === 0
        ? `no SOL transfer from ${fromAddress.slice(0, 8)}… to mint authority (${MINT_AUTHORITY_PUBKEY.slice(0, 8)}…) found in fee tx`
        : `SOL fee too small: ${totalLamports} lamports (minimum ${MIN_LAMPORTS})`,
      debug,
    };
  }

  return { ok: true };
}

// ── Stuck-state diagnosis ────────────────────────────────────────────────────
// Pure function that converts a row + verification result into a human
// explanation of what state the bridge is in and what (if anything) is wrong.
// Returned by /debug so issues are obvious without reading source.

function diagnose(row: any, verification: any): string {
  if (row.status === "minted") return "minted ✓ — done";
  if (row.status === "failed") return `failed: ${row.error ?? "(no error message)"}`;
  if (row.status === "minting") return "mint in flight — waiting for execute-mint to finish";

  if (row.status === "pending") {
    return `BLOB tx not yet in a block (confirmations=${row.confirmations ?? 0})`;
  }

  if (row.status === "confirmed") {
    const confs = Number(row.confirmations ?? 0);
    if (confs < REQUIRED_CONFIRMATIONS) {
      return `BLOB confirmations ${confs}/${REQUIRED_CONFIRMATIONS} — waiting`;
    }
    if (!row.sol_signature) {
      return "no sol_signature on row — registration was incomplete";
    }
    if (!MINT_AUTHORITY_PUBKEY) {
      return "MINT_AUTHORITY_PUBKEY not derived — check SOLANA_MINT_AUTHORITY_SECRET_KEY env var";
    }
    if (!verification) return "(verification not run)";
    if (verification.pending) {
      return `SOL fee tx not visible to RPC — ${verification.error}. Likely cluster mismatch (SOLANA_RPC_URL points to a different network than the user's wallet)`;
    }
    if (!verification.ok) {
      const transfers = verification.debug?.transfers_in_tx ?? [];
      if (transfers.length > 0) {
        const wrongDest = transfers.find((t: any) => t.source === row.sol_address);
        if (wrongDest && wrongDest.destination !== MINT_AUTHORITY_PUBKEY) {
          return `SOL was sent to ${wrongDest.destination} but backend expects ${MINT_AUTHORITY_PUBKEY}. ` +
            `The frontend reads the mint authority from on-chain, the backend derives it from SOLANA_MINT_AUTHORITY_SECRET_KEY — they don't match.`;
        }
      }
      return `verification failed: ${verification.error}`;
    }
    return "ready to mint — next poll should trigger auto-mint";
  }

  return `unknown status: ${row.status}`;
}

// ── Atomic auto-mint ──────────────────────────────────────────────────────────

async function triggerAutoMint(supa: Supa, row: any): Promise<any> {
  // Atomic claim — .eq("status", "confirmed") guard prevents double-mint
  const { data: claimed } = await supa
    .from("bridge_requests")
    .update({ status: "minting", error: null })
    .eq("blob_tx_id", row.blob_tx_id)
    .eq("status", "confirmed")
    .select().single();

  if (!claimed) {
    const { data: fresh } = await supa
      .from("bridge_requests").select("*").eq("blob_tx_id", row.blob_tx_id).maybeSingle();
    return fresh ?? row;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/bridge-execute-mint`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
        "apikey":        SERVICE_KEY,
      },
      body: JSON.stringify({ recipient: row.sol_address, amount: Number(row.amount) }),
    });
    const json = await res.json().catch(() => ({}));

    if (res.ok && json?.signature) {
      const { data: minted } = await supa.from("bridge_requests")
        .update({
          status:        "minted",
          sol_signature: json.signature,   // overwrite fee-payment sig with mint tx sig
          minted_at:     new Date().toISOString(),
          error:         null,
        })
        .eq("blob_tx_id", row.blob_tx_id)
        .select().single();
      console.log("[bridge-mint] minted", json.signature, "for", row.blob_tx_id);
      return minted ?? claimed;
    }

    const errMsg = json?.error || `execute-mint failed (${res.status})`;
    console.error("[bridge-mint] auto-mint failed:", errMsg);
    await supa.from("bridge_requests")
      .update({ status: "failed", error: errMsg })
      .eq("blob_tx_id", row.blob_tx_id);
    return { ...claimed, status: "failed", error: errMsg };

  } catch (e) {
    const errMsg = String((e as Error)?.message ?? e);
    console.error("[bridge-mint] auto-mint exception:", errMsg);
    await supa.from("bridge_requests")
      .update({ status: "failed", error: errMsg })
      .eq("blob_tx_id", row.blob_tx_id);
    return { ...claimed, status: "failed", error: errMsg };
  }
}

// ── processRequest ────────────────────────────────────────────────────────────

async function processRequest(supa: Supa, row: any, nodeUrl: string | null) {
  if (row.status === "minted" || row.status === "failed" || row.status === "minting") return row;

  // 1. Update BLOB confirmation depth from the node
  if ((row.status === "pending" || row.status === "confirmed") && nodeUrl) {
    const found = await findConfirmedBridgeTx(
      nodeUrl, row.blob_tx_id, row.from_address, Number(row.amount),
    );
    if (!found) return row;
    const confs  = found.confirmations;
    const patch: Record<string, unknown> = { confirmations: confs };
    if (row.status === "pending") {
      patch.status       = "confirmed";
      patch.confirmed_at = new Date().toISOString();
      row.status         = "confirmed";
    }
    await supa.from("bridge_requests").update(patch).eq("blob_tx_id", row.blob_tx_id);
    row.confirmations = confs;
  }

  // 2. Once the BLOB tx has enough confirmations, verify the SOL fee
  //    payment and trigger the mint.  If the SOL tx is still in-flight
  //    (pending: true), just return — next poll will retry.
  if (
    row.status === "confirmed" &&
    row.sol_signature &&
    Number(row.confirmations ?? 0) >= REQUIRED_CONFIRMATIONS
  ) {
    const payment = await verifySolPayment(row.sol_signature, row.sol_address);

    if (payment.pending) {
      console.log("[bridge-mint] SOL fee not confirmed yet for", row.blob_tx_id);
      return row;
    }

    if (!payment.ok) {
      const errMsg = `SOL fee invalid: ${payment.error}`;
      console.error("[bridge-mint]", errMsg);
      await supa.from("bridge_requests")
        .update({ status: "failed", error: errMsg })
        .eq("blob_tx_id", row.blob_tx_id);
      return { ...row, status: "failed", error: errMsg };
    }

    return await triggerAutoMint(supa, row);
  }

  return row;
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const url = new URL(req.url);

  // ── Config ───────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname.endsWith("/config")) {
    return ok_({
      bridgeAddress:       BRIDGE_ADDRESS,
      splMintAddress:      SOLANA_SPL_MINT_ADDRESS || null,
      mintAuthorityPubkey: MINT_AUTHORITY_PUBKEY    || null,
    });
  }

  // ── Audit ────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname.endsWith("/audit")) {
    const { data, error } = await supa.from("bridge_audit").select("*").maybeSingle();
    if (error) return bad("audit failed", 500);
    return ok_(data ?? {
      total_locked_blob: 0, total_minted_blob: 0,
      unreconciled_blob: 0, unreconciled_count: 0, total_bridge_txs: 0,
    });
  }

  // ── Recovery ─────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname.endsWith("/recover")) {
    try {
      const body = (await req.json()) ?? {};
      const { blob_tx_id, node_url } = body;
      if (typeof blob_tx_id !== "string" || !TX_ID_RE.test(blob_tx_id)) return bad("invalid blob_tx_id");
      const nodeUrl = sanitizeNodeUrl(node_url);
      if (!nodeUrl) return bad("invalid or missing node_url");
      const found = await findConfirmedBridgeTx(nodeUrl, blob_tx_id, null, null);
      if (!found) return bad("tx not found in chain", 404);
      const memoSol = extractSolFromMemo(found.memo);
      if (!memoSol) return bad("on-chain tx has no sol: memo");
      const { data: existing } = await supa.from("bridge_requests")
        .select("*").eq("blob_tx_id", blob_tx_id).maybeSingle();
      let row = existing;
      if (!row) {
        const { data: inserted, error: insErr } = await supa.from("bridge_requests")
          .insert({
            blob_tx_id, from_address: String(found.tx.from), sol_address: memoSol,
            amount: Number(found.tx.amount), status: "confirmed",
            confirmed_at: new Date().toISOString(),
          }).select().single();
        if (insErr) { console.error("[recover] insert failed", insErr); return bad("internal error", 500); }
        row = inserted;
      } else if (row.status === "failed" || row.status === "pending") {
        const { data: upd } = await supa.from("bridge_requests")
          .update({ status: "confirmed", confirmed_at: new Date().toISOString(), error: null })
          .eq("blob_tx_id", blob_tx_id).select().single();
        row = upd ?? row;
      }
      return ok_(await processRequest(supa, row, nodeUrl));
    } catch (e) { console.error("[recover] error", e); return bad("internal error", 500); }
  }

  // ── Debug ────────────────────────────────────────────────────────────
  // GET /functions/v1/bridge-mint/debug?blob_tx_id=<id>
  //
  // Returns the full row plus everything we'd need to figure out why a
  // bridge request isn't progressing past "confirmed".  No auth — only
  // returns data already publicly readable from the bridge.
  if (req.method === "GET" && url.pathname.endsWith("/debug")) {
    try {
      const txId = url.searchParams.get("blob_tx_id") ?? "";
      if (!TX_ID_RE.test(txId)) return bad("invalid blob_tx_id");

      const { data: row } = await supa.from("bridge_requests")
        .select("*").eq("blob_tx_id", txId).maybeSingle();
      if (!row) return bad("not found", 404);

      // Only run verification while we'd expect to be using sol_signature
      // as a SOL fee sig (i.e. NOT after mint, when it's been overwritten
      // with the WBLOB mint tx sig).
      let verification: any = null;
      if (row.sol_signature && row.status !== "minted") {
        verification = await verifySolPayment(row.sol_signature, row.sol_address);
      }

      return ok_({
        row,
        config: {
          mint_authority_pubkey:  MINT_AUTHORITY_PUBKEY || null,
          solana_rpc_host:        SOLANA_RPC_URL ? new URL(SOLANA_RPC_URL).host : null,
          spl_mint_address:       SOLANA_SPL_MINT_ADDRESS || null,
          required_confirmations: REQUIRED_CONFIRMATIONS,
        },
        verification,
        diagnosis: diagnose(row, verification),
      });
    } catch (e) {
      console.error("[bridge-mint/debug] error", e);
      return bad(`debug error: ${(e as Error)?.message ?? e}`, 500);
    }
  }

  // ── GET status poll ──────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const txId = url.searchParams.get("blob_tx_id") ?? "";
      if (!TX_ID_RE.test(txId)) return bad("invalid blob_tx_id");
      const nodeUrl = sanitizeNodeUrl(url.searchParams.get("node_url"));
      const { data: row } = await supa.from("bridge_requests")
        .select("*").eq("blob_tx_id", txId).maybeSingle();
      if (!row) return bad("not found", 404);
      return ok_(await processRequest(supa, row, nodeUrl));
    } catch (e) {
      console.error("[bridge-mint/poll] error", e);
      return bad(`poll error: ${(e as Error)?.message ?? e}`, 500);
    }
  }

  if (req.method !== "POST") return bad("method not allowed", 405);

  // ── Registration ─────────────────────────────────────────────────────
  try {
    const body = await req.json();
    const { blob_tx_id, sol_address, amount, from_address, node_url, sol_signature } = body ?? {};

    if (typeof blob_tx_id   !== "string" || !TX_ID_RE.test(blob_tx_id))      return bad("invalid blob_tx_id");
    if (typeof sol_address  !== "string" || !SOL_ADDR_RE.test(sol_address))   return bad("invalid sol_address");
    if (typeof from_address !== "string" || !BLOB_ADDR_RE.test(from_address)) return bad("invalid from_address");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return bad("invalid amount");
    if (typeof sol_signature !== "string" || !SOL_SIG_RE.test(sol_signature))
      return bad("invalid sol_signature — send the SOL bridge fee first");
    const nodeUrl = sanitizeNodeUrl(node_url);
    if (!nodeUrl) return bad("invalid or missing node_url");

    console.log("[bridge-mint] register", { blob_tx_id, sol_signature: sol_signature.slice(0, 12) + "…" });

    // Mempool diagnostic
    let mempoolDump: any[] = [];
    try {
      mempoolDump = await fetchNodeJson(nodeUrl, "/mempool");
      const match = Array.isArray(mempoolDump) && mempoolDump.find((t) => t?.id === blob_tx_id);
      console.log("[bridge-mint] mempool", Array.isArray(mempoolDump) ? mempoolDump.length : "?", "txs | match:", !!match);
    } catch { /* non-fatal */ }

    const pending   = await findPendingBridgeTx(nodeUrl, blob_tx_id, from_address, amt);
    const confirmed = pending ? null : await findConfirmedBridgeTx(nodeUrl, blob_tx_id, from_address, amt);

    if (!pending && !confirmed) {
      return new Response(JSON.stringify({
        error: "matching BLOB transaction not found in mempool or chain",
        debug: {
          nodeUrl, looking_for: { blob_tx_id, from_address, amount: amt, to: BRIDGE_ADDRESS },
          mempool_size: Array.isArray(mempoolDump) ? mempoolDump.length : null,
          mempool_sample: Array.isArray(mempoolDump)
            ? mempoolDump.slice(0, 3).map((t) => ({ id: t?.id, from: t?.from, to: t?.to, amount: t?.amount }))
            : null,
        },
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const memoSol = extractSolFromMemo(pending ? pending.memo : confirmed!.memo);
    if (!memoSol)                return bad("originating tx is missing a valid sol: memo");
    if (memoSol !== sol_address) return bad("sol_address does not match tx memo");

    const { data: existing } = await supa.from("bridge_requests")
      .select("*").eq("blob_tx_id", blob_tx_id).maybeSingle();

    let row = existing;
    if (!row) {
      const { data: inserted, error: insErr } = await supa.from("bridge_requests")
        .insert({
          blob_tx_id, from_address, sol_address, amount: amt,
          status:       confirmed ? "confirmed" : "pending",
          confirmed_at: confirmed ? new Date().toISOString() : null,
          sol_signature,
        }).select().single();
      if (insErr) { console.error("[bridge-mint] insert failed", insErr); return bad("internal error", 500); }
      row = inserted;
    } else if (!row.sol_signature) {
      // Back-fill fee sig for a row registered without one
      await supa.from("bridge_requests")
        .update({ sol_signature }).eq("blob_tx_id", blob_tx_id);
      row.sol_signature = sol_signature;
    }

    return ok_(await processRequest(supa, row, nodeUrl));
  } catch (e) {
    console.error("[bridge-mint] error", e);
    return bad("internal error", 500);
  }
});