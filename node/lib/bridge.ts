// Bridge code removed from full nodes — the bridge is custodial (it holds
// Solana mint authority) and runs on Supabase edge functions only.
//
// This file is kept as a stub so any stale imports fail loudly during the
// transition. Delete it once you've verified nothing imports from it.

export function ensureBridgeSchema(_d: unknown) { /* no-op */ }
export function bridgeEnabled(): boolean { return false; }
export function bridgeConfig() {
  return { bridgeAddress: "", splMintAddress: null, solanaRpcUrl: null, enabled: false };
}
export function registerMint(_d: unknown, _body: unknown) {
  return { ok: false as const, error: "bridge runs on the website, not on full nodes" };
}
export function getMintRow(_d: unknown, _id: string) { return null; }
export function registerRedeem(_d: unknown, _body: unknown) {
  return { ok: false as const, error: "bridge runs on the website, not on full nodes" };
}
export function getRedeemRow(_d: unknown, _sig: string) { return null; }
export async function processForwardOnce(_d: unknown, _log: unknown) { /* no-op */ }
export async function processReverseOnce(_d: unknown, _log: unknown) { /* no-op */ }
