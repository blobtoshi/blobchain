// Lightweight public config endpoint for the bridge UI.
// Kept separate from `bridge-mint` so it doesn't pay the boot cost of the
// heavy Solana web3 / spl-token modules.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// MUST match BRIDGE_ADDRESS in src/lib/blob/constants.ts.
<<<<<<< HEAD
const BRIDGE_ADDRESS = "19xGuoUEng3w4Y2DjP6te2LLTSKt7fKs27";
=======
const BRIDGE_ADDRESS = "1E4QWFYb5Pqj8iAV2be8Ee88yEbvhU9iTs";
>>>>>>> f707b92fa569ff89f0f1c20167310489f865f154

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(
    JSON.stringify({
      bridgeAddress: BRIDGE_ADDRESS,
      splMintAddress: Deno.env.get("SOLANA_SPL_MINT_ADDRESS") ?? null,
      solanaRpcUrl: Deno.env.get("SOLANA_RPC_URL") ?? null,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
  );
});
