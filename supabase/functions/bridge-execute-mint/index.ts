// Dedicated SPL mint executor. Called only by bridge-mint (server-to-server,
// authenticated with the service role key). Lives in its own function so the
// heavy @solana/web3.js + @solana/spl-token imports get their own per-request
// CPU budget instead of competing with the mint-orchestration logic.

import {
  Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction,
} from "https://esm.sh/@solana/web3.js@1.95.4";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "https://esm.sh/@solana/spl-token@0.4.9?deps=@solana/web3.js@1.95.4&bundle-deps";
import bs58 from "https://esm.sh/bs58@5.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SOLANA_RPC_URL          = Deno.env.get("SOLANA_RPC_URL") ?? "";
const SOLANA_MINT_AUTHORITY   = Deno.env.get("SOLANA_MINT_AUTHORITY_SECRET_KEY") ?? "";
const SOLANA_SPL_MINT_ADDRESS = Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? "";
const SERVICE_KEY             = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return bad("method not allowed", 405);

  // Service-role check — only bridge-mint should call this.
  const auth = req.headers.get("authorization") ?? "";
  if (!SERVICE_KEY || auth !== `Bearer ${SERVICE_KEY}`) return bad("unauthorized", 401);

  try {
    const { recipient, amount } = (await req.json()) ?? {};
    if (typeof recipient !== "string" || !SOL_ADDR_RE.test(recipient)) return bad("invalid recipient");
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000) return bad("invalid amount");

    if (!SOLANA_RPC_URL || !SOLANA_MINT_AUTHORITY || !SOLANA_SPL_MINT_ADDRESS) {
      return bad("solana env missing", 500);
    }

    const raw = SOLANA_MINT_AUTHORITY.trim();
    const authority = raw.startsWith("[")
      ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
      : Keypair.fromSecretKey(bs58.decode(raw));

    const conn = new Connection(SOLANA_RPC_URL, "confirmed");
    const mintPub = new PublicKey(SOLANA_SPL_MINT_ADDRESS);
    const recipientPub = new PublicKey(recipient);

    const mintInfo = await getMint(conn as any, mintPub);
    const baseUnits = BigInt(Math.round(amt * 10 ** mintInfo.decimals));
    if (baseUnits <= 0n) return bad("amount rounds to zero base units");

    const ata = await getAssociatedTokenAddress(mintPub, recipientPub, true);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, ata, recipientPub, mintPub,
      ),
      createMintToInstruction(mintPub, ata, authority.publicKey, baseUnits),
    );

    const signature = await sendAndConfirmTransaction(conn, tx, [authority], {
      commitment: "confirmed",
    });

    return new Response(JSON.stringify({ signature }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error("[bridge-execute-mint] error", msg);
    return bad(msg, 500);
  }
});
