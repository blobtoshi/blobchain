// P2P WBLOB ↔ USDC Pool — symmetric two-sided CLOB on Solana.
//
// Both sides escrow assets up front (principal + 1% fee in their native asset):
//   Sell: deposit (amount + 1%) WBLOB to escrow, memo `pool-sell:<price>:<amount>`
//   Buy : deposit (amount*price + 1%) USDC to escrow, memo `pool-buy:<price>:<amount>`
//
// On /place, backend verifies the deposit and matches against the opposite
// side of the book (FIFO by price-time). Each fill atomically pulls from
// escrow:
//   - WBLOB to buyer  (net of 1% WBLOB fee → treasury)
//   - USDC  to seller (net of 1% USDC  fee → treasury)
//
// Cancel: signed Ed25519 message refunds remaining principal + remaining fee
// (in the order's native asset) back to the owner.

import { createClient as _createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import * as ed from "https://esm.sh/@noble/ed25519@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.4.0/sha256";
import bs58 from "https://esm.sh/bs58@5.0.0";
// deno-lint-ignore no-explicit-any
const createClient = _createClient as any;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// ── Config ─────────────────────────────────────────────────────────
const WBLOB_MINT  = Deno.env.get("WBLOB_MINT") ?? "8e5J22uXLm2utLEbnvZCLWP7hHKxe1r6G46bh5Xunwb2";
const USDC_MINT   = Deno.env.get("USDC_MINT")  ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_RPC     = Deno.env.get("SOLANA_RPC_URL") ?? "";
const ESCROW_SK   = Deno.env.get("POOL_ESCROW_SOL_SECRET_KEY") ?? "";
const TREASURY    = Deno.env.get("TREASURY_SOL_ADDRESS") ?? "";
const FEE_BPS     = Number(Deno.env.get("POOL_FEE_BPS") ?? "100"); // 1% per side
const USDC_DECIMALS = 6;
// Per-order SOL network-fee budget the trader deposits to fund the
// escrow's release tx (to counterparty + treasury) and the refund tx on cancel.
// Default 0.005 SOL — covers up to ~2 ATA creations + a few release txs + a refund.
const POOL_SOL_FEE_LAMPORTS = BigInt(Deno.env.get("POOL_SOL_FEE_LAMPORTS") ?? "5000000");

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE      = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (msg: string, status = 400) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const ok_ = (o: unknown) =>
  new Response(JSON.stringify(o), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

// ── Solana helpers (inline) ─────────────────────────────────────────
const TOKEN_PROGRAM_ID            = bs58.decode("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = bs58.decode("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM_ID           = new Uint8Array(32);
const MEMO_PROGRAM_ID_B58         = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

function isOnCurve(p: Uint8Array) { try { ed.ExtendedPoint.fromHex(p); return true; } catch { return false; } }
function pdaCreate(seeds: Uint8Array[], pid: Uint8Array): Uint8Array | null {
  const M = new TextEncoder().encode("ProgramDerivedAddress");
  let n = 0; for (const s of seeds) n += s.length;
  const buf = new Uint8Array(n + pid.length + M.length);
  let o = 0; for (const s of seeds) { buf.set(s, o); o += s.length; }
  buf.set(pid, o); o += pid.length; buf.set(M, o);
  const h = sha256(buf); return isOnCurve(h) ? null : h;
}
function findPDA(seeds: Uint8Array[], pid: Uint8Array) {
  for (let b = 255; b >= 0; b--) { const a = pdaCreate([...seeds, new Uint8Array([b])], pid); if (a) return a; }
  throw new Error("PDA not found");
}
function getATA(owner: Uint8Array, mint: Uint8Array) { return findPDA([owner, TOKEN_PROGRAM_ID, mint], ASSOCIATED_TOKEN_PROGRAM_ID); }
function shortVec(n: number) { const o: number[] = []; let v = n; while (true) { let b = v & 0x7f; v >>>= 7; if (v === 0) { o.push(b); break; } b |= 0x80; o.push(b); } return new Uint8Array(o); }
function concat(...a: Uint8Array[]) { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; }
function u64le(n: bigint) { const o = new Uint8Array(8); new DataView(o.buffer).setBigUint64(0, n, true); return o; }

type Meta = { pubkey: Uint8Array; isSigner: boolean; isWritable: boolean };
type Ix = { programId: Uint8Array; keys: Meta[]; data: Uint8Array };

function buildMessage(feePayer: Uint8Array, blockhash: Uint8Array, ixs: Ix[]) {
  const metas = new Map<string, Meta>();
  const k = (p: Uint8Array) => bs58.encode(p);
  const upsert = (m: Meta) => { const key = k(m.pubkey); const ex = metas.get(key); if (!ex) metas.set(key, { ...m }); else { ex.isSigner ||= m.isSigner; ex.isWritable ||= m.isWritable; } };
  upsert({ pubkey: feePayer, isSigner: true, isWritable: true });
  for (const ix of ixs) { for (const ky of ix.keys) upsert(ky); upsert({ pubkey: ix.programId, isSigner: false, isWritable: false }); }
  const all = [...metas.values()];
  const fpKey = k(feePayer);
  all.sort((a, b) => { if (k(a.pubkey) === fpKey) return -1; if (k(b.pubkey) === fpKey) return 1; const r = (m: Meta) => (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1); return r(a) - r(b); });
  let nS = 0, nRS = 0, nRNS = 0;
  for (const m of all) { if (m.isSigner) { nS++; if (!m.isWritable) nRS++; } else if (!m.isWritable) nRNS++; }
  const accountKeys = all.map(m => m.pubkey);
  const idx = (p: Uint8Array) => accountKeys.findIndex(a => bs58.encode(a) === bs58.encode(p));
  const compiled: Uint8Array[] = [];
  for (const ix of ixs) {
    const pIdx = idx(ix.programId);
    const ai = new Uint8Array(ix.keys.map(ky => idx(ky.pubkey)));
    compiled.push(concat(new Uint8Array([pIdx]), shortVec(ai.length), ai, shortVec(ix.data.length), ix.data));
  }
  const header = new Uint8Array([nS, nRS, nRNS]);
  const keysBlob = concat(shortVec(accountKeys.length), ...accountKeys);
  const ixBlob = concat(shortVec(compiled.length), ...compiled);
  return { message: concat(header, keysBlob, blockhash, ixBlob), accountKeys, numSigners: nS };
}
function transferCheckedIx(src: Uint8Array, mint: Uint8Array, dst: Uint8Array, owner: Uint8Array, amt: bigint, dec: number): Ix {
  return { programId: TOKEN_PROGRAM_ID, keys: [
    { pubkey: src, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: dst, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ], data: concat(new Uint8Array([12]), u64le(amt), new Uint8Array([dec])) };
}
function createAtaIdempotentIx(payer: Uint8Array, ata: Uint8Array, owner: Uint8Array, mint: Uint8Array): Ix {
  return { programId: ASSOCIATED_TOKEN_PROGRAM_ID, keys: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ], data: new Uint8Array([1]) };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  if (!SOL_RPC) throw new Error("SOLANA_RPC_URL not configured");
  const r = await fetch(SOL_RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

function parseSecretKey(raw: string) {
  const t = raw.trim();
  const sk: Uint8Array = t.startsWith("[") ? Uint8Array.from(JSON.parse(t)) : bs58.decode(t);
  if (sk.length !== 64) throw new Error("secret key must be 64 bytes");
  return { priv: sk.slice(0, 32), pub: sk.slice(32, 64) };
}

let _wblobDecimals: number | null = null;
async function wblobDecimals() {
  if (_wblobDecimals !== null) return _wblobDecimals;
  const acct = await rpc<any>("getAccountInfo", [WBLOB_MINT, { encoding: "base64", commitment: "confirmed" }]);
  if (!acct?.value?.data?.[0]) throw new Error("WBLOB mint not found");
  const data = Uint8Array.from(atob(acct.value.data[0]), c => c.charCodeAt(0));
  _wblobDecimals = data[44]; return _wblobDecimals;
}

// Send N transfers of `mint` from escrow to many recipients in one tx.
// Each item: { to: <ownerB58>, amount: <uiAmount> }. Returns sig or error.
async function escrowMultiSend(
  mintB58: string,
  decimals: number,
  items: { to: string; amount: number }[],
): Promise<{ ok: true; sig: string } | { ok: false; error: string }> {
  if (!ESCROW_SK) return { ok: false, error: "POOL_ESCROW_SOL_SECRET_KEY not configured" };
  const filtered = items.filter((x) => x.amount > 0);
  if (filtered.length === 0) return { ok: true, sig: "" };
  try {
    const { priv, pub } = parseSecretKey(ESCROW_SK);
    const mint = bs58.decode(mintB58);
    const escrowAta = getATA(pub, mint);
    const ixs: Ix[] = [];
    for (const it of filtered) {
      const owner = bs58.decode(it.to);
      const ata = getATA(owner, mint);
      const baseUnits = BigInt(Math.round(it.amount * 10 ** decimals));
      if (baseUnits <= 0n) continue;
      ixs.push(createAtaIdempotentIx(pub, ata, owner, mint));
      ixs.push(transferCheckedIx(escrowAta, mint, ata, pub, baseUnits, decimals));
    }
    if (ixs.length === 0) return { ok: true, sig: "" };
    const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "finalized" }]);
    const blockhash = bs58.decode(bh.value.blockhash);
    const { message, numSigners } = buildMessage(pub, blockhash, ixs);
    const sig = await ed.signAsync(message, priv);
    const sigBlobs: Uint8Array[] = [];
    for (let i = 0; i < numSigners; i++) sigBlobs.push(sig);
    const wire = concat(shortVec(numSigners), ...sigBlobs, message);
    const wireB64 = btoa(String.fromCharCode(...wire));
    const txSig = await rpc<string>("sendTransaction", [wireB64, { encoding: "base64", skipPreflight: false, maxRetries: 5, preflightCommitment: "processed" }]);
    return { ok: true, sig: txSig };
  } catch (e) { return { ok: false, error: String((e as Error).message ?? e).slice(0, 500) }; }
}

// SystemProgram.transfer instruction (lamports).
function systemTransferIx(from: Uint8Array, to: Uint8Array, lamports: bigint): Ix {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true); // instruction index 2 = Transfer
  new DataView(data.buffer).setBigUint64(4, lamports, true);
  return { programId: SYSTEM_PROGRAM_ID, keys: [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: to,   isSigner: false, isWritable: true },
  ], data };
}

// Send SOL from escrow to a recipient. Used for refunding unused network-fee budget.
async function escrowSendSol(toB58: string, lamports: bigint): Promise<{ ok: true; sig: string } | { ok: false; error: string }> {
  if (!ESCROW_SK) return { ok: false, error: "POOL_ESCROW_SOL_SECRET_KEY not configured" };
  if (lamports <= 0n) return { ok: true, sig: "" };
  try {
    const { priv, pub } = parseSecretKey(ESCROW_SK);
    const to = bs58.decode(toB58);
    const ix = systemTransferIx(pub, to, lamports);
    const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "finalized" }]);
    const blockhash = bs58.decode(bh.value.blockhash);
    const { message, numSigners } = buildMessage(pub, blockhash, [ix]);
    const sig = await ed.signAsync(message, priv);
    const sigBlobs: Uint8Array[] = []; for (let i = 0; i < numSigners; i++) sigBlobs.push(sig);
    const wire = concat(shortVec(numSigners), ...sigBlobs, message);
    const wireB64 = btoa(String.fromCharCode(...wire));
    const txSig = await rpc<string>("sendTransaction", [wireB64, { encoding: "base64", skipPreflight: false, maxRetries: 5, preflightCommitment: "processed" }]);
    return { ok: true, sig: txSig };
  } catch (e) { return { ok: false, error: String((e as Error).message ?? e).slice(0, 500) }; }
}

// Compute SOL (native lamport) deltas per account from a parsed tx.
function solDeltasByAccount(tx: any): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const keys: string[] = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => typeof k === "string" ? k : k.pubkey);
  const pre: number[] = tx?.meta?.preBalances ?? [];
  const post: number[] = tx?.meta?.postBalances ?? [];
  for (let i = 0; i < keys.length; i++) {
    const d = BigInt(post[i] ?? 0) - BigInt(pre[i] ?? 0);
    if (d !== 0n) out.set(keys[i], (out.get(keys[i]) ?? 0n) + d);
  }
  return out;
}

function extractMemo(tx: any): string | null {
  const ixs = tx?.transaction?.message?.instructions ?? [];
  for (const ix of ixs) {
    if (ix.programId === MEMO_PROGRAM_ID_B58) {
      if (typeof ix.parsed === "string") return ix.parsed;
      if (ix.parsed?.info?.memo) return ix.parsed.info.memo;
      if (typeof ix.data === "string") {
        try { return new TextDecoder().decode(Uint8Array.from(atob(ix.data), c => c.charCodeAt(0))); } catch { /* */ }
      }
    }
  }
  return null;
}
function sumDeltasByOwner(tx: any, mintFilter: string): Map<string, number> {
  const out = new Map<string, number>();
  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  const mp = new Map<number, any>(); for (const b of pre) mp.set(b.accountIndex, b);
  const mq = new Map<number, any>(); for (const b of post) mq.set(b.accountIndex, b);
  for (const idx of new Set<number>([...mp.keys(), ...mq.keys()])) {
    const p = mp.get(idx), q = mq.get(idx);
    const mint = q?.mint ?? p?.mint; if (mint !== mintFilter) continue;
    const owner = q?.owner ?? p?.owner; if (!owner) continue;
    const d = (Number(q?.uiTokenAmount?.uiAmount ?? 0) || 0) - (Number(p?.uiTokenAmount?.uiAmount ?? 0) || 0);
    if (d === 0) continue;
    out.set(owner, (out.get(owner) ?? 0) + d);
  }
  return out;
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round8 = (n: number) => Math.round(n * 1e8) / 1e8;

// ─────────────────── Matching engine ───────────────────
// Cross `taker` against the resting opposite side. Updates orders, writes
// fills, and dispatches escrow releases (one tx per asset side).
async function matchOrder(supa: any, taker: any) {
  const oppositeSide = taker.side === "buy" ? "sell" : "buy";
  // Buyer matches lowest asks first; seller matches highest bids first.
  const priceOrder = taker.side === "buy" ? "asc" : "desc";
  const { data: book } = await supa.from("pool_orders")
    .select("*")
    .eq("side", oppositeSide)
    .in("status", ["open", "partial"])
    .gt("remaining_wblob", 0)
    .order("price_usdc", { ascending: priceOrder === "asc" })
    .order("created_at", { ascending: true })
    .limit(200);

  const wblobDec = await wblobDecimals();
  const wblobReleases = new Map<string, number>(); // recipient → ui amount
  const usdcReleases  = new Map<string, number>();
  const fillRows: any[] = [];
  let takerRem = Number(taker.remaining_wblob);
  let takerDepRem = Number(taker.remaining_deposit);
  let takerFeeRem = Number(taker.remaining_fee);
  let takerSolRem = BigInt(taker.remaining_sol_fee_lamports ?? 0);
  let totalWblobFee = 0, totalUsdcFee = 0;

  for (const maker of book ?? []) {
    if (takerRem <= 1e-9) break;
    const makerPx = Number(maker.price_usdc);
    // Price compatibility:
    //   buy taker fills if maker.ask <= taker.bid
    //   sell taker fills if maker.bid >= taker.ask
    if (taker.side === "buy"  && makerPx > Number(taker.price_usdc) + 1e-9) break;
    if (taker.side === "sell" && makerPx < Number(taker.price_usdc) - 1e-9) break;
    const fillPx = makerPx; // maker price wins (price-time priority)
    const makerRem = Number(maker.remaining_wblob);
    const wblob = round8(Math.min(takerRem, makerRem));
    if (wblob <= 0) continue;
    const usdc = round6(wblob * fillPx);
    if (usdc <= 0) continue;

    // Determine buyer/seller and compute proportional fee draw from each.
    const buyer  = taker.side === "buy"  ? taker  : maker;
    const seller = taker.side === "sell" ? taker  : maker;
    // Buyer's deposit asset is USDC. Buyer's fill cost = usdc.
    // Buyer's fee draw  = usdc / (buyer.amount_wblob * buyer.price_usdc) * buyer.fee_amount
    const buyerNotional = Number(buyer.amount_wblob) * Number(buyer.price_usdc);
    const buyerFeePortion = buyerNotional > 0 ? round6(usdc / buyerNotional * Number(buyer.fee_amount)) : 0;
    // Seller's deposit asset is WBLOB. Seller's fill principal = wblob.
    // Seller's fee draw = wblob / seller.amount_wblob * seller.fee_amount
    const sellerFeePortion = Number(seller.amount_wblob) > 0
      ? round8(wblob / Number(seller.amount_wblob) * Number(seller.fee_amount))
      : 0;

    // Update maker order
    const newMakerRem = round8(makerRem - wblob);
    const makerIsBuy = maker.side === "buy";
    const makerDepDraw = makerIsBuy ? usdc : wblob;
    const makerFeeDraw = makerIsBuy ? buyerFeePortion : sellerFeePortion;
    const newMakerDep = Math.max(0, round8(Number(maker.remaining_deposit) - makerDepDraw));
    const newMakerFee = Math.max(0, round8(Number(maker.remaining_fee) - makerFeeDraw));
    // Proportional SOL fee draw on the maker (fraction of order filled by this trade).
    const makerSolBudget = BigInt(maker.sol_fee_lamports ?? 0);
    const makerSolRem    = BigInt(maker.remaining_sol_fee_lamports ?? 0);
    const makerAmtUnits = BigInt(Math.round(Number(maker.amount_wblob) * 1e8));
    const fillUnits     = BigInt(Math.round(wblob * 1e8));
    let makerSolDraw = makerAmtUnits > 0n ? (makerSolBudget * fillUnits) / makerAmtUnits : 0n;
    if (makerSolDraw > makerSolRem) makerSolDraw = makerSolRem;
    const newMakerSolRem = makerSolRem - makerSolDraw;
    const makerStatus = newMakerRem <= 1e-9 ? "filled" : "partial";
    const upd = await supa.from("pool_orders").update({
      remaining_wblob: newMakerRem,
      remaining_deposit: newMakerDep,
      remaining_fee: newMakerFee,
      remaining_sol_fee_lamports: newMakerSolRem.toString(),
      status: makerStatus,
    }).eq("id", maker.id).eq("remaining_wblob", makerRem).select().maybeSingle();
    if (!upd?.data) continue; // raced — skip

    // Update taker locals (commit to DB after loop)
    takerRem = round8(takerRem - wblob);
    const takerDepDraw = taker.side === "buy" ? usdc : wblob;
    const takerFeeDraw = taker.side === "buy" ? buyerFeePortion : sellerFeePortion;
    takerDepRem = Math.max(0, round8(takerDepRem - takerDepDraw));
    takerFeeRem = Math.max(0, round8(takerFeeRem - takerFeeDraw));
    const takerSolBudget = BigInt(taker.sol_fee_lamports ?? 0);
    const takerAmtUnits  = BigInt(Math.round(Number(taker.amount_wblob) * 1e8));
    let takerSolDraw = takerAmtUnits > 0n ? (takerSolBudget * fillUnits) / takerAmtUnits : 0n;
    if (takerSolDraw > takerSolRem) takerSolDraw = takerSolRem;
    takerSolRem = takerSolRem - takerSolDraw;

    // Schedule outflows from escrow
    // Buyer receives net WBLOB; seller fee in WBLOB → treasury.
    const buyerWblob = round8(wblob - sellerFeePortion);
    if (buyerWblob > 0) wblobReleases.set(buyer.owner_sol_address, round8((wblobReleases.get(buyer.owner_sol_address) ?? 0) + buyerWblob));
    if (sellerFeePortion > 0 && TREASURY) {
      wblobReleases.set(TREASURY, round8((wblobReleases.get(TREASURY) ?? 0) + sellerFeePortion));
      totalWblobFee = round8(totalWblobFee + sellerFeePortion);
    }
    // Seller receives net USDC; buyer fee in USDC → treasury.
    const sellerUsdc = round6(usdc - buyerFeePortion);
    if (sellerUsdc > 0) usdcReleases.set(seller.owner_sol_address, round6((usdcReleases.get(seller.owner_sol_address) ?? 0) + sellerUsdc));
    if (buyerFeePortion > 0 && TREASURY) {
      usdcReleases.set(TREASURY, round6((usdcReleases.get(TREASURY) ?? 0) + buyerFeePortion));
      totalUsdcFee = round6(totalUsdcFee + buyerFeePortion);
    }

    fillRows.push({
      maker_order_id: maker.id,
      taker_order_id: taker.id,
      buyer_sol_address: buyer.owner_sol_address,
      seller_sol_address: seller.owner_sol_address,
      price_usdc: fillPx,
      wblob_amount: wblob,
      usdc_amount: usdc,
      fee_wblob: TREASURY ? sellerFeePortion : 0,
      fee_usdc: TREASURY ? buyerFeePortion : 0,
      status: "pending_release",
    });
  }

  // Commit taker
  const takerStatus = takerRem <= 1e-9
    ? "filled"
    : (Number(taker.remaining_wblob) !== takerRem ? "partial" : "open");
  await supa.from("pool_orders").update({
    remaining_wblob: takerRem,
    remaining_deposit: takerDepRem,
    remaining_fee: takerFeeRem,
    remaining_sol_fee_lamports: takerSolRem.toString(),
    status: takerStatus,
  }).eq("id", taker.id);

  // Insert fills
  let insertedFills: any[] = [];
  if (fillRows.length > 0) {
    const { data } = await supa.from("pool_fills").insert(fillRows).select();
    insertedFills = data ?? [];
  }

  // Dispatch escrow tx (one per asset)
  let releaseWblobSig = "", releaseUsdcSig = "", releaseErr = "";
  if (wblobReleases.size > 0) {
    const r = await escrowMultiSend(WBLOB_MINT, wblobDec,
      Array.from(wblobReleases.entries()).map(([to, amount]) => ({ to, amount })));
    if (r.ok) releaseWblobSig = r.sig; else releaseErr = `wblob: ${r.error}`;
  }
  if (usdcReleases.size > 0) {
    const r = await escrowMultiSend(USDC_MINT, USDC_DECIMALS,
      Array.from(usdcReleases.entries()).map(([to, amount]) => ({ to, amount })));
    if (r.ok) releaseUsdcSig = r.sig; else releaseErr = (releaseErr ? releaseErr + " | " : "") + `usdc: ${r.error}`;
  }

  // Mark fills released/failed
  if (insertedFills.length > 0) {
    const ids = insertedFills.map((f) => f.id);
    if (releaseErr && !releaseWblobSig && !releaseUsdcSig) {
      await supa.from("pool_fills").update({ status: "failed", error: releaseErr.slice(0, 500) }).in("id", ids);
    } else {
      await supa.from("pool_fills").update({
        status: "released",
        release_wblob_sig: releaseWblobSig || null,
        release_usdc_sig: releaseUsdcSig || null,
        error: releaseErr ? releaseErr.slice(0, 500) : null,
      }).in("id", ids);
    }
  }

  return { fills: insertedFills.length, releaseWblobSig, releaseUsdcSig, releaseErr };
}

// ── HTTP handler ────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const url = new URL(req.url);

  // GET /book (and / and /pool-orders)
  if (req.method === "GET" && (url.pathname.endsWith("/pool-orders") || url.pathname.endsWith("/pool-orders/") || url.pathname.endsWith("/book"))) {
    const owner = url.searchParams.get("owner") || url.searchParams.get("seller"); // back-compat
    const escrowAddr = ESCROW_SK ? (() => { try { return bs58.encode(parseSecretKey(ESCROW_SK).pub); } catch { return null; } })() : null;
    const [{ data: bookRows }, { data: fills }] = await Promise.all([
      supa.from("pool_orders").select("*").in("status", ["open", "partial"]).gt("remaining_wblob", 0).limit(400),
      supa.from("pool_fills").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    const asks = (bookRows ?? []).filter((r: any) => r.side === "sell").sort((a: any, b: any) => Number(a.price_usdc) - Number(b.price_usdc));
    const bids = (bookRows ?? []).filter((r: any) => r.side === "buy").sort((a: any, b: any) => Number(b.price_usdc) - Number(a.price_usdc));
    let mine: any[] = [];
    if (owner && SOL_ADDR_RE.test(owner)) {
      const { data } = await supa.from("pool_orders").select("*").eq("owner_sol_address", owner).order("created_at", { ascending: false }).limit(100);
      mine = data ?? [];
    }
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { data: recent } = await supa.from("pool_fills").select("wblob_amount,usdc_amount").gte("created_at", since);
    let vol_blob = 0, vol_usdc = 0;
    for (const f of recent ?? []) { vol_blob += Number(f.wblob_amount); vol_usdc += Number(f.usdc_amount); }
    const lastFill = (fills ?? [])[0];
    const last_price = lastFill ? Number(lastFill.usdc_amount) / Number(lastFill.wblob_amount) : null;
    return ok_({
      escrow_address: escrowAddr,
      wblob_mint: WBLOB_MINT,
      usdc_mint: USDC_MINT,
      treasury: TREASURY || null,
      fee_bps: FEE_BPS,
      sol_fee_lamports: POOL_SOL_FEE_LAMPORTS.toString(),
      asks, bids, fills: fills ?? [], mine,
      stats: { vol_blob, vol_usdc, last_price },
    });
  }

  // GET /candles
  if (req.method === "GET" && url.pathname.endsWith("/candles")) {
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const { data } = await supa.from("pool_fills").select("wblob_amount,usdc_amount,created_at,status").gte("created_at", since).order("created_at", { ascending: true });
    const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number; t: number }>();
    const HOUR = 3600_000;
    for (const f of data ?? []) {
      if (f.status === "failed") continue;
      const px = Number(f.usdc_amount) / Number(f.wblob_amount);
      const t = Math.floor(new Date(f.created_at).getTime() / HOUR) * HOUR;
      const b = buckets.get(t);
      if (!b) buckets.set(t, { o: px, h: px, l: px, c: px, v: Number(f.wblob_amount), t });
      else { b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.c = px; b.v += Number(f.wblob_amount); }
    }
    return ok_({ candles: Array.from(buckets.values()).sort((a, b) => a.t - b.t) });
  }

  if (req.method !== "POST") return bad("method not allowed", 405);

  // POST /place — register a deposit & match
  if (url.pathname.endsWith("/place") || url.pathname.endsWith("/create")) {
    try {
      const body = await req.json();
      const side = String(body?.side ?? "");
      const owner = String(body?.owner_sol_address ?? body?.seller_sol_address ?? "");
      const sig = String(body?.deposit_sig ?? body?.wblob_deposit_sig ?? "");
      const price = Number(body?.price_usdc);
      const amt = Number(body?.amount_wblob);
      if (side !== "buy" && side !== "sell") return bad("invalid side");
      if (!SOL_ADDR_RE.test(owner)) return bad("invalid owner_sol_address");
      if (!SIG_RE.test(sig)) return bad("invalid deposit_sig");
      if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) return bad("invalid price_usdc");
      if (!Number.isFinite(amt) || amt <= 0 || amt > 1_000_000_000) return bad("invalid amount_wblob");
      if (!ESCROW_SK) return bad("escrow not configured", 500);

      // Idempotent on deposit signature.
      const { data: existing } = await supa.from("pool_orders").select("*").eq("deposit_sig", sig).maybeSingle();
      if (existing) return ok_(existing);

      // Verify on chain (finalized).
      let tx: any;
      try {
        tx = await rpc<any>("getTransaction", [sig, { maxSupportedTransactionVersion: 0, commitment: "finalized", encoding: "jsonParsed" }]);
      } catch (e) { return bad(`rpc: ${(e as Error).message}`, 502); }
      if (!tx) return bad("deposit tx not finalized yet", 425);
      if (tx.meta?.err) return bad(`deposit tx failed: ${JSON.stringify(tx.meta.err)}`);

      const escrowB58 = bs58.encode(parseSecretKey(ESCROW_SK).pub);
      const memo = extractMemo(tx);
      const expectedMemo = `pool-${side}:${price}:${amt}`;
      if (memo !== expectedMemo) return bad(`memo mismatch (expected "${expectedMemo}")`);

      let depositAmount: number, feeAmount: number;
      if (side === "sell") {
        depositAmount = amt;
        feeAmount = TREASURY ? round8(amt * (FEE_BPS / 10_000)) : 0;
        const deltas = sumDeltasByOwner(tx, WBLOB_MINT);
        const escrowDelta = deltas.get(escrowB58) ?? 0;
        const ownerDelta  = deltas.get(owner) ?? 0;
        const need = round8(depositAmount + feeAmount);
        if (escrowDelta + 1e-9 < need) return bad(`escrow received ${escrowDelta} WBLOB, need ${need}`);
        if (ownerDelta > -need + 1e-9) return bad(`seller did not debit ${need} WBLOB (got ${ownerDelta})`);
      } else {
        depositAmount = round6(amt * price);
        feeAmount = TREASURY ? round6(depositAmount * (FEE_BPS / 10_000)) : 0;
        const deltas = sumDeltasByOwner(tx, USDC_MINT);
        const escrowDelta = deltas.get(escrowB58) ?? 0;
        const ownerDelta  = deltas.get(owner) ?? 0;
        const need = round6(depositAmount + feeAmount);
        if (escrowDelta + 1e-6 < need) return bad(`escrow received ${escrowDelta} USDC, need ${need}`);
        if (ownerDelta > -need + 1e-6) return bad(`buyer did not debit ${need} USDC (got ${ownerDelta})`);
      }

      // Verify SOL network-fee budget was deposited to escrow account.
      const solDeltas = solDeltasByAccount(tx);
      const escrowSolDelta = solDeltas.get(escrowB58) ?? 0n;
      if (escrowSolDelta < POOL_SOL_FEE_LAMPORTS) {
        return bad(`escrow received ${escrowSolDelta} lamports SOL fee, need ${POOL_SOL_FEE_LAMPORTS}`);
      }

      const { data: inserted, error } = await supa.from("pool_orders").insert({
        side, owner_sol_address: owner,
        price_usdc: price, amount_wblob: amt, remaining_wblob: amt,
        deposit_amount: depositAmount, remaining_deposit: depositAmount,
        fee_amount: feeAmount, remaining_fee: feeAmount,
        sol_fee_lamports: POOL_SOL_FEE_LAMPORTS.toString(),
        remaining_sol_fee_lamports: POOL_SOL_FEE_LAMPORTS.toString(),
        status: "open", deposit_sig: sig,
      }).select().single();
      if (error) return bad(error.message, 500);

      // Match
      try { await matchOrder(supa, inserted); } catch (e) { console.error("match error", e); }
      const { data: out } = await supa.from("pool_orders").select("*").eq("id", inserted.id).maybeSingle();
      return ok_(out);
    } catch (e) { return bad(String((e as Error).message ?? e), 500); }
  }

  // POST /cancel — refund remaining principal + remaining fee in native asset
  if (url.pathname.endsWith("/cancel")) {
    try {
      const { order_id, ts, signature_b58 } = await req.json();
      if (typeof order_id !== "string" || !UUID_RE.test(order_id)) return bad("invalid order_id");
      if (typeof signature_b58 !== "string" || !SIG_RE.test(signature_b58)) return bad("invalid signature");
      const tsN = Number(ts);
      if (!Number.isFinite(tsN) || Math.abs(Date.now() - tsN) > 5 * 60_000) return bad("stale signature");

      const { data: row } = await supa.from("pool_orders").select("*").eq("id", order_id).maybeSingle();
      if (!row) return bad("not found", 404);
      if (row.status === "cancelled" || row.status === "filled") return ok_(row);

      const ownerPub = bs58.decode(row.owner_sol_address);
      const sigBytes = bs58.decode(signature_b58);
      const msg = new TextEncoder().encode(`pool-cancel:${order_id}:${tsN}`);
      const okSig = await ed.verifyAsync(sigBytes, msg, ownerPub);
      if (!okSig) return bad("invalid cancel signature", 401);

      // Atomically claim
      const { data: claimed } = await supa.from("pool_orders").update({ status: "cancelling" })
        .eq("id", order_id).in("status", ["open", "partial", "pending_deposit"]).select().maybeSingle();
      if (!claimed) {
        const { data: cur } = await supa.from("pool_orders").select("*").eq("id", order_id).maybeSingle();
        return ok_(cur);
      }

      const refundPrincipal = Number(claimed.remaining_deposit);
      const refundFee = Number(claimed.remaining_fee);
      const refundTotal = round8(refundPrincipal + refundFee);
      let refundSig = "";
      if (refundTotal > 0) {
        const mintB58 = claimed.side === "sell" ? WBLOB_MINT : USDC_MINT;
        const dec = claimed.side === "sell" ? await wblobDecimals() : USDC_DECIMALS;
        const r = await escrowMultiSend(mintB58, dec, [{ to: claimed.owner_sol_address, amount: refundTotal }]);
        if (!r.ok) {
          await supa.from("pool_orders").update({ status: "open", error: r.error.slice(0, 500) }).eq("id", order_id);
          return bad(r.error, 500);
        }
        refundSig = r.sig;
      }
      // Refund unused SOL network-fee budget (minus an estimated lamport cost
      // for this refund tx itself, ~5000 lamports base fee).
      const remSol = BigInt(claimed.remaining_sol_fee_lamports ?? 0);
      const SOL_REFUND_TX_COST = 5000n;
      if (remSol > SOL_REFUND_TX_COST) {
        const send = remSol - SOL_REFUND_TX_COST;
        const r = await escrowSendSol(claimed.owner_sol_address, send);
        if (!r.ok) console.error("sol refund failed:", r.error);
      }
      await supa.from("pool_orders").update({
        status: "cancelled",
        remaining_wblob: 0,
        remaining_deposit: 0,
        remaining_fee: 0,
        remaining_sol_fee_lamports: "0",
        cancelled_at: new Date().toISOString(),
        refund_sig: refundSig || null,
        error: null,
      }).eq("id", order_id);
      const { data: out } = await supa.from("pool_orders").select("*").eq("id", order_id).maybeSingle();
      return ok_(out);
    } catch (e) { return bad(String((e as Error).message ?? e), 500); }
  }

  return bad("not found", 404);
});
