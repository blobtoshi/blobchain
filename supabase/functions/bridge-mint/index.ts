// Bridge $BLOB → Solana SPL.
// Flow:
//   1. Client signs a normal $BLOB tx to BRIDGE_ADDRESS with memo `sol:<sol_address>`
//      and broadcasts it via submit-tx (mempool).
//   2. Client POSTs to this function with { blob_tx_id, sol_address, amount, from_address }
//      → we record a `pending` bridge_request.
//   3. Once the originating tx lands in a sealed block (verified by reading
//      blob_chain), we mint exactly `amount` SPL tokens to the recipient SOL
//      address using the configured mint authority and mark the request
//      `minted` with the Solana signature.
//   4. GET ?blob_tx_id=... polls status (and triggers a mint attempt if the
//      tx has since been confirmed). The client polls this until status =
//      'minted' or 'failed'.
import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
// deno type-check chokes on the 2.95 generics; cast to any so call sites stay clean.
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
// Solana deps via npm: specifier (Deno's native npm support — generally
// lighter at boot than esm.sh shims).
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "https://esm.sh/@solana/web3.js@1.95.4";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "https://esm.sh/@solana/spl-token@0.4.9?deps=@solana/web3.js@1.95.4&bundle-deps";
import bs58 from "https://esm.sh/bs58@5.0.0";

// Bridge deposit address on Blob Chain.
// MUST match GENESIS.bridgeAddress in src/lib/blob/constants.ts (pinned at genesis).
const BRIDGE_ADDRESS = "1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs";

const SOLANA_RPC_URL          = Deno.env.get("SOLANA_RPC_URL") ?? "";
const SOLANA_MINT_AUTHORITY   = Deno.env.get("SOLANA_MINT_AUTHORITY_SECRET_KEY") ?? "";
const SOLANA_SPL_MINT_ADDRESS = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BLOB_ADDR_RE = /^[1][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const TX_ID_RE = /^[0-9a-fA-F]{8,64}$/;

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

// Look for the bridge tx in the sealed chain. Returns the matching tx (or null).
async function findConfirmedBridgeTx(
  supa: Supa,
  txId: string,
  fromAddress: string,
  amount: number,
) {
  const { data: blocks } = await supa
    .from("blob_chain")
    .select("height,transactions")
    .order("height", { ascending: false })
    .limit(200);
  for (const b of blocks ?? []) {
    const txs = safeParse((b as any).transactions, []) as any[];
    for (const tx of txs) {
      if (tx.id === txId &&
          tx.from === fromAddress &&
          tx.to === BRIDGE_ADDRESS &&
          Number(tx.amount) === Number(amount)) {
        return { tx, height: Number((b as any).height), memo: typeof tx.memo === "string" ? tx.memo : "" };
      }
    }
  }
  return null;
}

// Extract the destination Solana address from a bridge tx memo (`sol:<addr>`).
function extractSolFromMemo(memo: unknown): string {
  if (typeof memo !== "string") return "";
  const m = memo.match(/^sol:([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  return m ? m[1] : "";
}

// Check if the tx is still in the mempool (not yet sealed).
async function findPendingBridgeTx(
  supa: Supa,
  txId: string,
  fromAddress: string,
  amount: number,
) {
  const { data } = await supa
    .from("blob_mempool")
    .select("id,from_address,to_address,amount,memo")
    .eq("id", txId).maybeSingle();
  if (!data) return null;
  if (data.from_address !== fromAddress) return null;
  if (data.to_address !== BRIDGE_ADDRESS) return null;
  if (Number(data.amount) !== Number(amount)) return null;
  return data;
}

function loadMintAuthority(): Keypair {
  // Accept base58 (88 chars typical) OR JSON array (e.g. "[12,34,...]").
  const raw = SOLANA_MINT_AUTHORITY.trim();
  if (raw.startsWith("[")) {
    const arr = JSON.parse(raw);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function mintSpl(
  recipient: string,
  amount: number,
): Promise<string> {
  if (!SOLANA_RPC_URL) throw new Error("SOLANA_RPC_URL is not configured");
  if (!SOLANA_MINT_AUTHORITY) throw new Error("SOLANA_MINT_AUTHORITY_SECRET_KEY is not configured");
  if (!SOLANA_SPL_MINT_ADDRESS) throw new Error("SOLANA_SPL_MINT_ADDRESS is not configured");

  const conn = new Connection(SOLANA_RPC_URL, "confirmed");
  const authority = loadMintAuthority();
  const mintPub = new PublicKey(SOLANA_SPL_MINT_ADDRESS);
  const recipientPub = new PublicKey(recipient);

  // Read the SPL mint to know its decimals so we mint the correct base units.
  const mintInfo = await getMint(conn as any, mintPub);
  const baseUnits = BigInt(Math.round(amount * 10 ** mintInfo.decimals));
  if (baseUnits <= 0n) throw new Error("Amount rounds to zero base units");

  const ata = await getAssociatedTokenAddress(mintPub, recipientPub, true);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey, ata, recipientPub, mintPub,
    ),
    createMintToInstruction(mintPub, ata, authority.publicKey, baseUnits),
  );

  const sig = await sendAndConfirmTransaction(conn, tx, [authority], {
    commitment: "confirmed",
  });
  return sig;
}

// Background mint task — runs after the response is returned, so the heavy
// solana-web3 + spl-token imports don't blow the request's CPU budget.
async function backgroundMint(supa: Supa, blob_tx_id: string, sol_address: string, amount: number) {
  try {
    const sig = await mintSpl(sol_address, amount);
    await supa.from("bridge_requests")
      .update({
        status: "minted",
        sol_signature: sig,
        minted_at: new Date().toISOString(),
        error: null,
      })
      .eq("blob_tx_id", blob_tx_id);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error("[bridge-mint] mint failed", blob_tx_id, msg);
    await supa.from("bridge_requests")
      .update({ status: "confirmed", error: msg })
      .eq("blob_tx_id", blob_tx_id);
  }
}

// Process a bridge request: confirm the originating $BLOB tx, then dispatch
// the mint as a background task. Idempotent — safe to call repeatedly.
async function processRequest(supa: Supa, row: any) {
  if (row.status === "minted" || row.status === "failed" || row.status === "minting") return row;

  // Step 1: is the $BLOB tx confirmed yet?
  const confirmed = await findConfirmedBridgeTx(
    supa, row.blob_tx_id, row.from_address, Number(row.amount),
  );
  if (!confirmed) {
    // Still pending — the user's tx hasn't been sealed in a block yet.
    return row;
  }

  if (row.status === "pending") {
    await supa.from("bridge_requests")
      .update({ status: "confirmed", confirmed_at: new Date().toISOString() })
      .eq("blob_tx_id", row.blob_tx_id);
    row.status = "confirmed";
    row.confirmed_at = new Date().toISOString();
  }

  // Atomically claim the row for minting so concurrent polls don't double-mint.
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

  // Dispatch the heavy mint in the background and return immediately.
  // @ts-ignore EdgeRuntime is provided by the Supabase Edge runtime.
  EdgeRuntime.waitUntil(backgroundMint(supa, row.blob_tx_id, row.sol_address, Number(row.amount)));
  return claimed;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Public config (so the UI can show the bridge address without hardcoding).
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname.endsWith("/config")) {
    return ok_({
      bridgeAddress: BRIDGE_ADDRESS,
      splMintAddress: SOLANA_SPL_MINT_ADDRESS || null,
    });
  }

  // GET ?blob_tx_id=... → return current status, attempt mint if ready.
  if (req.method === "GET") {
    const txId = url.searchParams.get("blob_tx_id") ?? "";
    if (!TX_ID_RE.test(txId)) return bad("invalid blob_tx_id");
    const { data: row } = await supa.from("bridge_requests")
      .select("*").eq("blob_tx_id", txId).maybeSingle();
    if (!row) return bad("not found", 404);
    const updated = await processRequest(supa, row);
    return ok_(updated);
  }

  if (req.method !== "POST") return bad("method not allowed", 405);

  try {
    const body = await req.json();
    const { blob_tx_id, sol_address, amount, from_address } = body ?? {};

    if (typeof blob_tx_id !== "string" || !TX_ID_RE.test(blob_tx_id))
      return bad("invalid blob_tx_id");
    if (typeof sol_address !== "string" || !SOL_ADDR_RE.test(sol_address))
      return bad("invalid sol_address");
    // Note: deeper PublicKey validation happens lazily inside mintSpl().
    if (typeof from_address !== "string" || !BLOB_ADDR_RE.test(from_address))
      return bad("invalid from_address");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000)
      return bad("invalid amount");

    // Verify a corresponding tx exists either pending in mempool or already sealed.
    const pending = await findPendingBridgeTx(supa, blob_tx_id, from_address, amt);
    const confirmed = pending ? null : await findConfirmedBridgeTx(supa, blob_tx_id, from_address, amt);
    if (!pending && !confirmed) {
      return bad("matching BLOB transaction not found in mempool or chain");
    }

    // CRITICAL: the destination Solana address MUST match the `sol:<addr>` memo
    // signed into the originating BLOB tx. Otherwise a mempool watcher could
    // race the victim's POST and redirect the mint to their own wallet.
    const memoSol = extractSolFromMemo(pending ? (pending as any).memo : (confirmed as any).memo);
    if (!memoSol) return bad("originating tx is missing a valid sol: memo");
    if (memoSol !== sol_address) return bad("sol_address does not match tx memo");

    // Upsert as pending. If a row already exists, keep its current status.
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
        })
        .select().single();
      if (insErr) {
        console.error("[bridge-mint] request insert failed", insErr);
        return bad("internal error", 500);
      }
      row = inserted;
    }

    const updated = await processRequest(supa, row);
    return ok_(updated);
  } catch (e) {
    console.error("[bridge-mint] unexpected error", e);
    return bad("internal error", 500);
  }
});
