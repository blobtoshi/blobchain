import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  TrendingUpDown, ExternalLink, Loader2, CheckCircle2, AlertCircle, Copy, Wallet,
} from "lucide-react";
import { sha256hex, signData } from "@/lib/blob/crypto";
import { canonicalTxBytes, estimateTxBytes, feeFromRate, memoBytes, to8 } from "@/lib/blob/fees";
import {
  BASE_FEE_RATE, MIN_FEE_RATE, MAX_MEMO_BYTES, BLOB_DECIMALS,
} from "@/lib/blob/constants";
import bridgeCoinsImg from "@/assets/bridge-coins.png";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Transaction, SystemProgram, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";


const SolanaProvider = lazy(() => import("./SolanaProvider"));
const RedeemPanel = lazy(() => import("./RedeemPanel"));

export default function BridgeScreen(props: any) {
  const { wallet } = props;
  const [config, setConfig] = useState<{ bridgeAddress: string; splMintAddress: string | null; solanaRpcUrl?: string | null; mintAuthorityPubkey?: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let t: any = null;
    const load = async () => {
      const cfg = await Relay.fetchBridgeConfig();
      if (cancelled) return;
      if (cfg) setConfig(cfg);
      else t = setTimeout(load, 2000);
    };
    load();
    return () => { cancelled = true; if (t) clearTimeout(t); };
  }, []);

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl glass-pane px-5 sm:px-8 py-8 sm:py-10">
        <div className="pointer-events-none absolute -top-32 right-0 w-[420px] h-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -left-12 w-[320px] h-[320px] rounded-full bg-accent/10 blur-3xl" />
        <img
          src={bridgeCoinsImg}
          alt=""
          aria-hidden="true"
          className="pointer-events-none select-none absolute -right-6 sm:right-2 top-1/2 -translate-y-1/2 w-40 sm:w-56 md:w-64 opacity-40 sm:opacity-50 mix-blend-screen drop-shadow-[0_0_30px_hsl(var(--accent)/0.35)]"
        />
        <div className="relative flex flex-col gap-3 pr-32 sm:pr-48">
          <div className="flex items-center gap-2">
            <div className="relative inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 border border-primary/30 text-primary shadow-[0_0_24px_hsl(var(--accent)/0.25)]">
              <span className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_30%,hsl(var(--accent)/0.35),transparent_70%)]" />
              <TrendingUpDown className="relative w-4 h-4" />
            </div>
            <span className="label-eyebrow">Bridge</span>
          </div>
          <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight">
            <span className="text-foreground">Bridge </span>
            <span className="text-brand-gradient drop-shadow-[0_0_24px_hsl(var(--accent)/0.35)]">BLOB</span>
            <span className="text-foreground"> ↔ Solana</span>
          </h1>
          <div className="text-sm text-muted-foreground max-w-xl leading-relaxed">
            Move value between Blob Chain and Solana.
          </div>
        </div>
      </div>

      <Suspense fallback={
        <div className="glass-hi p-10 flex items-center justify-center text-sm text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading Solana wallet…
        </div>
      }>
        <SolanaProvider endpoint={config?.solanaRpcUrl ?? null}>
          <Tabs defaultValue="forward" className="space-y-4">
            <TabsList className="grid grid-cols-2 max-w-md">
              <TabsTrigger value="forward">BLOB → WBLOB</TabsTrigger>
              <TabsTrigger value="reverse">WBLOB → BLOB</TabsTrigger>
            </TabsList>

            <TabsContent value="forward" className="mt-0">
              <ForwardBridge {...props} config={config} />
            </TabsContent>

            <TabsContent value="reverse" className="mt-0 data-[state=inactive]:hidden" forceMount>
              <RedeemPanel
                splMintAddress={config?.splMintAddress ?? null}
                defaultBlobAddress={wallet.address}
              />
            </TabsContent>
          </Tabs>
        </SolanaProvider>
      </Suspense>
    </div>
  );
}

function ForwardBridge({ wallet, chain, mempool, onBroadcast, config: cfgProp, balance = 0 }: any) {
  const [config, setConfig] = useState(cfgProp ?? null);
  useEffect(() => { if (cfgProp) setConfig(cfgProp); }, [cfgProp]);

  const { connection } = useConnection();
  const solWallet = useWallet();
  const solPubkey = solWallet.publicKey?.toBase58() ?? "";

  const [amt, setAmt] = useState("");
  const [st, setSt] = useState<"idle" | "signing" | "broadcasting" | "registering" | "waiting" | "preparing" | "wallet" | "submitting" | "minted" | "failed">("idle");
  const [err, setErr] = useState("");
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [activeRequest, setActiveRequest] = useState<Relay.BridgeRequest | null>(null);
  const [history, setHistory] = useState<Relay.BridgeRequest[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [fi, hist] = await Promise.all([
        Relay.fetchFeeInfo(),
        Relay.fetchBridgeHistory(wallet.address),
      ]);
      if (cancelled) return;
      if (fi) setFeeInfo(fi);
      setHistory(hist);
    })();
    const id = setInterval(async () => {
      const hist = await Relay.fetchBridgeHistory(wallet.address);
      if (!cancelled) setHistory(hist);
    }, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [wallet.address]);

  useEffect(() => {
    const currentDone = !activeRequest || activeRequest.status === "minted" || activeRequest.status === "failed";
    if (!currentDone) return;
    const inflight = history.find((h) => h.status === "pending" || h.status === "confirmed" || h.status === "minting");
    if (!inflight) return;
    setActiveRequest(inflight);
    setSt(inflight.status === "minting" ? "wallet" : "waiting");
  }, [history, activeRequest]);

  // Poll status, and once confirmations reach the threshold, auto-trigger the
  // Poll active bridge request and update status.
  useEffect(() => {
    if (!activeRequest) return;
    if (activeRequest.status === "minted" || activeRequest.status === "failed") return;

    let cancelled = false;
    const poll = async () => {
      const r = await Relay.pollBridgeRequest(activeRequest.blob_tx_id);
      if (!r || cancelled) return;
      setActiveRequest(r);
      setHistory((prev) => {
        const next = prev.filter((item) => item.blob_tx_id !== r.blob_tx_id);
        return [r, ...next];
      });
      if (r.status === "minted") { setSt("minted"); return; }
      if (r.status === "failed") { setSt("failed"); setErr(r.error || "Mint failed"); return; }
      // "minting" means bridge-execute-mint is running autonomously on the backend.
      // Nothing the user needs to do — just keep polling.
      setSt("waiting");
    };

    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeRequest?.blob_tx_id, activeRequest?.status]);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;
  const activeFeeRate = Math.max(MIN_FEE_RATE, recRate);
  const parsedAmt = (() => { const n = parseFloat(amt); return Number.isFinite(n) && n > 0 ? to8(n) : 0; })();
  const memoStr = solPubkey ? `sol:${solPubkey}` : "";
  const memoLen = memoBytes(memoStr);
  const memoOver = memoLen > MAX_MEMO_BYTES;
  const previewBytes = config && parsedAmt > 0 && !memoOver && solPubkey
    ? estimateTxBytes(wallet.address, config.bridgeAddress, parsedAmt, Date.now(), activeFeeRate, memoStr)
    : 0;
  const previewFee = previewBytes ? feeFromRate(activeFeeRate, previewBytes) : 0;
  const previewTotal = parsedAmt + previewFee;

  const canSubmit =
    !!config && st === "idle" && !!solPubkey && parsedAmt > 0 && !memoOver && previewTotal <= balance;

  async function bridge() {
    setErr("");
    if (!config) { setErr("Bridge not configured"); return; }
    if (!solPubkey) { setErr("Connect a Solana wallet first"); return; }
    if (parsedAmt <= 0) { setErr("Invalid amount"); return; }
    if (memoOver) { setErr(`Memo too long (${memoLen}/${MAX_MEMO_BYTES})`); return; }
    if (previewTotal > balance) { setErr("Insufficient balance"); return; }
    const mintAuthority = config.mintAuthorityPubkey;
    if (!mintAuthority) { setErr("Mint authority not available - bridge config error"); return; }
    if (!solWallet.sendTransaction) { setErr("Solana wallet does not support sendTransaction"); return; }
    if (!config.splMintAddress) { setErr("WBLOB mint address not available"); return; }

    setSt("preparing");
    try {
      // Front-load all async prep work IN PARALLEL so we get to
      // sendTransaction as fast as possible. Phantom's popup is most
      // reliable when the call happens within ~1s of the user click;
      // sequential awaits stretch that out and the popup ends up needing
      // a tab focus to show.
      //
      //   1. Build & sign the BLOB tx locally (we don't broadcast yet)
      //   2. Fetch latest Solana blockhash
      //   3. Check whether the user already has a WBLOB ATA - if yes, we
      //      only need ~0.00001 SOL for the tx fee; if no, ~0.00204 for
      //      ATA rent + fee. Saves users with an existing ATA from being
      //      charged the full rent every time.
      const ts = Date.now();
      const splMint = new PublicKey(config.splMintAddress);
      const solOwnerPk = solWallet.publicKey!;

      // H2: compute the tx id first, then bind id + a single-use nonce into the
      // signed payload so the bridge deposit tx can't be replayed or
      // re-broadcast under a different id.
      const txid = (await sha256hex(`${wallet.address}${config.bridgeAddress}${parsedAmt}${ts}${activeFeeRate}${memoStr}`)).slice(0, 40);
      const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, "0")).join("");
      const data = `${txid}:${wallet.address}->${config.bridgeAddress}:${parsedAmt}@${ts}|fr=${activeFeeRate}|m=${memoStr}|n=${nonce}`;

      const [
        sigBlobLocal,
        latestBlockhash,
        ataInfo,
      ] = await Promise.all([
        signData(wallet.privateKey, data),
        connection.getLatestBlockhash("confirmed"),
        // ATA existence check. getAssociatedTokenAddress is sync (just key
        // derivation); getAccountInfo on it tells us if it exists on chain.
        getAssociatedTokenAddress(splMint, solOwnerPk).then(async (ata) => {
          const info = await connection.getAccountInfo(ata, "confirmed");
          return { ata, exists: info != null };
        }),
      ]);

      const bytes = canonicalTxBytes({
        from: wallet.address, to: config.bridgeAddress, amount: parsedAmt, timestamp: ts,
        feeRate: activeFeeRate, memo: memoStr, publicKey: wallet.publicKey, signature: sigBlobLocal,
      });
      const fee = feeFromRate(activeFeeRate, bytes);
      const blobTx = {
        id: txid,
        nonce,
        from: wallet.address,
        to: config.bridgeAddress, amount: parsedAmt, fee,
        feeRate: activeFeeRate, memo: memoStr,
        signature: sigBlobLocal, publicKey: wallet.publicKey,
        timestamp: ts, status: "pending",
      };

      // ── SOL fee payment ───────────────────────────────────────────────
      // ATA rent is ~0.00204 SOL, charged once per token account. If the
      // user already has a WBLOB ATA we only need to cover the tx fee.
      // We add a small buffer for fluctuations in fee market / ATA rent.
      const ATA_RENT_LAMPORTS = Math.ceil(0.00204 * LAMPORTS_PER_SOL);
      const TX_FEE_BUFFER     = Math.ceil(0.0001  * LAMPORTS_PER_SOL); // generous, covers normal fees + buffer
      const lamports = ataInfo.exists ? TX_FEE_BUFFER : (ATA_RENT_LAMPORTS + TX_FEE_BUFFER);

      const solTx = new Transaction({
        recentBlockhash: latestBlockhash.blockhash,
        feePayer: solOwnerPk,
      }).add(
        SystemProgram.transfer({
          fromPubkey: solOwnerPk,
          toPubkey: new PublicKey(mintAuthority),
          lamports,
        })
      );

      // ── Phantom popup: call sendTransaction NOW ───────────────────────
      // Everything above was prep; this is the single call that triggers
      // the wallet popup. Keeping it close to the click event by avoiding
      // intermediate await-and-rerender cycles makes the popup actually
      // appear without needing tab focus.
      setSt("wallet");
      let solSignature: string;
      try {
        solSignature = await solWallet.sendTransaction(solTx, connection, {
          maxRetries: 3,
        });
      } catch (e: any) {
        setErr(e?.message?.includes("rejected") ? "SOL payment cancelled - no BLOB has been deducted" : `SOL payment failed: ${e?.message ?? String(e)}`);
        setSt("failed");
        return;
      }

      // Confirm before broadcasting BLOB.
      setSt("registering");
      try {
        await connection.confirmTransaction({
          signature: solSignature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        }, "confirmed");
      } catch (e: any) {
        setErr(`SOL payment did not confirm: ${e?.message ?? String(e)}. Please contact support if SOL was deducted.`);
        setSt("failed");
        return;
      }

      // ── NOW broadcast the BLOB tx ─────────────────────────────────────
      // SOL is paid and confirmed. If the BLOB broadcast fails here the
      // user has paid the SOL fee for nothing; we surface that clearly so
      // they can contact support (the SOL is recoverable by the operator).
      setSt("broadcasting");
      const res = await Relay.pushTx(blobTx);
      if (!res.ok) {
        setErr(`SOL paid (${solSignature.slice(0, 8)}...) but BLOB broadcast failed: ${res.error || "unknown"}. Contact support with the SOL signature for a refund.`);
        setSt("failed");
        return;
      }
      onBroadcast(blobTx);

      setSt("registering");
      const reg = await Relay.registerBridgeRequest({
        blob_tx_id: txid,
        sol_address: solPubkey,
        amount: parsedAmt,
        from_address: wallet.address,
        sol_signature: solSignature,
      });
      if (!reg.ok || !reg.data) { setErr(reg.error || "Bridge registration failed"); setSt("failed"); return; }
      setActiveRequest(reg.data);
      setSt(reg.data.status === "minted" ? "minted"
         : reg.data.status === "minting" ? "wallet"
         : "waiting");
      setAmt("");
    } catch (e) { setErr(String(e)); setSt("failed"); }
  }

  function reset() {
    setSt("idle"); setErr(""); setActiveRequest(null);
  }

  const copyBridge = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config.bridgeAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const StatusPill = ({ r }: { r: Relay.BridgeRequest }) => {
    const N = Relay.BRIDGE_REQUIRED_CONFIRMATIONS;
    const confs = Math.max(0, Math.min(N, Number(r.confirmations ?? 0)));
    const map = {
      pending:   { text: "Waiting for block",                       cls: "text-muted-foreground border-border" },
      confirmed: { text: `Awaiting confirmations (${confs}/${N})`,  cls: "text-primary border-primary/40" },
      minting:   { text: "Awaiting wallet",                         cls: "text-primary border-primary/40" },
      minted:    { text: "Minted",                                  cls: "text-[hsl(var(--success,142_70%_45%))] border-[hsl(var(--success,142_70%_45%))]/40" },
      failed:    { text: "Failed",                                  cls: "text-destructive border-destructive/40" },
    } as const;
    const m = map[r.status];
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${m.cls}`}>
        {r.status === "minted" ? <CheckCircle2 className="w-3 h-3" />
         : r.status === "failed" ? <AlertCircle className="w-3 h-3" />
         : <Loader2 className="w-3 h-3 animate-spin" />}
        {m.text}
      </span>
    );
  };

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="glass-hi p-5 sm:p-6 space-y-4">
            <div className="label-eyebrow">Bridge BLOB → WBLOB</div>

            {/* Solana wallet connect: required up-front so we can lock the
                recipient address to the connected wallet. This is what makes
                the rent-harvesting attack uneconomical — the user's own
                wallet pays the ATA rent. */}
            <div className="space-y-1.5">
              <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                Solana wallet (recipient)
              </Label>
              <div className="flex items-center gap-2 flex-wrap">
                <WalletMultiButton style={{
                  background: "hsl(var(--card) / 0.6)",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: "0.5rem",
                  height: "36px",
                  fontSize: "12px",
                  padding: "0 12px",
                  color: "hsl(var(--foreground))",
                }} />
                {solPubkey && (
                  <span className="num text-[10px] text-muted-foreground truncate flex-1">
                    {solPubkey}
                  </span>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground flex items-start gap-1.5">
                <Wallet className="w-3 h-3 mt-0.5 shrink-0" />
                <span>You will approve a ~0.0025 SOL payment to cover ATA rent + mint fee, then sign the BLOB tx.</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                Bridge deposit address
              </Label>
              <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-border bg-card/40">
                <span className="num text-xs text-foreground/80 truncate flex-1">
                  {config?.bridgeAddress ?? "Loading…"}
                </span>
                <button
                  type="button"
                  onClick={copyBridge}
                  disabled={!config}
                  className="text-[10px] px-2 py-1 rounded border border-border hover:border-primary/40 hover:text-primary transition shrink-0 disabled:opacity-50"
                >
                  {copied ? "Copied" : <><Copy className="w-3 h-3 inline -mt-0.5" /> Copy</>}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                  Amount
                </Label>
                <button
                  type="button"
                  onClick={() => {
                    const rate = Math.max(MIN_FEE_RATE, feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE);
                    const memoNow = solPubkey ? `sol:${solPubkey}` : "";
                    const bridgeAddr = config?.bridgeAddress ?? wallet.address;
                    let candidate = balance;
                    for (let i = 0; i < 2; i++) {
                      const bytes = estimateTxBytes(
                        wallet.address, bridgeAddr, to8(candidate), Date.now(), rate, memoNow,
                      );
                      const fee = feeFromRate(rate, bytes);
                      candidate = Math.max(0, balance - fee);
                    }
                    setAmt(candidate.toFixed(BLOB_DECIMALS));
                  }}
                  className="text-[10px] text-muted-foreground hover:text-primary transition"
                  disabled={balance <= 0}
                >
                  Max: <span className="num">{balance.toFixed(BLOB_DECIMALS)}</span>
                </button>
              </div>
              <div className="relative">
                <Input
                  value={amt}
                  onChange={(e) => setAmt(e.target.value)}
                  placeholder="0.00000000"
                  inputMode="decimal"
                  className="num pr-16"
                  disabled={st !== "idle" && st !== "failed" && st !== "minted"}
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  BLOB
                </span>
              </div>
            </div>

            {parsedAmt > 0 && (
              <div className="rounded-lg border border-border bg-card/30 p-3 text-[11px] space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">You send</span>
                  <span className="num">{parsedAmt.toFixed(BLOB_DECIMALS)} BLOB</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Network fee (~{previewBytes} B × {activeFeeRate} drops/B)</span>
                  <span className="num">{previewFee.toFixed(BLOB_DECIMALS)}</span>
                </div>
                <div className="flex justify-between border-t border-border pt-1 mt-1">
                  <span className="text-muted-foreground">Total deducted</span>
                  <span className="num font-medium">{previewTotal.toFixed(BLOB_DECIMALS)}</span>
                </div>
                <div className="flex justify-between text-primary">
                  <span>You receive on Solana</span>
                  <span className="num">{parsedAmt.toFixed(BLOB_DECIMALS)} WBLOB</span>
                </div>
              </div>
            )}

            {err && (
              <div className="text-xs text-destructive flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {err}
              </div>
            )}

            <button
              type="button"
              onClick={bridge}
              disabled={!canSubmit}
              className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:bg-primary/90 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
            >
              {st === "idle" || st === "minted" || st === "failed" ? (
                <><TrendingUpDown className="w-4 h-4" /> Bridge to Solana</>
              ) : st === "signing" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Signing BLOB tx…</>
              ) : st === "broadcasting" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Broadcasting BLOB tx…</>
              ) : st === "preparing" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Preparing SOL payment…</>
              ) : st === "wallet" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Approve in Phantom…</>
              ) : st === "registering" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Registering bridge…</>
              ) : st === "waiting" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for confirmations…</>
              ) : (
                <><Loader2 className="w-4 h-4 animate-spin" /> Submitting to Solana…</>
              )}
            </button>

            {/* If the auto-trigger missed (user rejected popup, or wallet
                disconnected), let them retry without re-bridging. */}
            {activeRequest &&
              (activeRequest.status === "confirmed" || activeRequest.status === "minting") &&
              Number(activeRequest.confirmations ?? 0) >= Relay.BRIDGE_REQUIRED_CONFIRMATIONS &&
              st !== "preparing" && st !== "wallet" && st !== "submitting" && (
                <button
                  type="button"
                  onClick={() => activeRequest && runClientMint(activeRequest)}
                  className="w-full text-xs px-4 py-2 rounded-full border border-primary/40 text-primary hover:bg-primary/10 transition"
                >
                  Complete mint on Solana
                </button>
              )}
          </div>

          {activeRequest && (
            <div className="glass-hi p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="label-eyebrow">Latest bridge</div>
                <StatusPill r={activeRequest} />
              </div>
              <div className="grid grid-cols-2 gap-3 text-[11px]">
                <div>
                  <div className="text-muted-foreground mb-0.5">Amount</div>
                  <div className="num text-foreground">{Number(activeRequest.amount).toFixed(BLOB_DECIMALS)} BLOB</div>
                </div>
                <div>
                  <div className="text-muted-foreground mb-0.5">Solana recipient</div>
                  <div className="num text-foreground truncate">{activeRequest.sol_address}</div>
                </div>
                <div className="col-span-2">
                  <div className="text-muted-foreground mb-0.5">Blob tx</div>
                  <div className="num text-foreground truncate">{activeRequest.blob_tx_id}</div>
                </div>
                {activeRequest.sol_signature && (
                  <div className="col-span-2">
                    <div className="text-muted-foreground mb-0.5">Solana signature</div>
                    <a
                      href={`https://solscan.io/tx/${activeRequest.sol_signature}`}
                      target="_blank" rel="noreferrer"
                      className="num text-primary hover:underline inline-flex items-center gap-1 truncate"
                    >
                      {activeRequest.sol_signature}
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  </div>
                )}
                {activeRequest.error && (
                  <div className="col-span-2 text-destructive">{activeRequest.error}</div>
                )}
              </div>
              {(activeRequest.status === "minted" || activeRequest.status === "failed") && (
                <button
                  onClick={reset}
                  className="text-[11px] px-3 py-1.5 rounded-full border border-border hover:border-primary/40 hover:text-primary transition"
                >
                  Bridge another
                </button>
              )}
            </div>
          )}
        </div>

        <div className="lg:col-span-1 space-y-2">
          <div className="label-eyebrow px-1">Your bridge history</div>
          {history.length === 0 ? (
            <div className="glass px-5 py-10 text-center text-sm text-muted-foreground">
              No bridges yet
            </div>
          ) : (
            <div className="space-y-1.5">
              {history.map((h) => (
                <div key={h.blob_tx_id} className="glass px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="num text-sm font-medium">{Number(h.amount).toFixed(BLOB_DECIMALS)} BLOB</span>
                    <StatusPill r={h} />
                  </div>
                  <div className="num text-[10px] text-muted-foreground truncate">→ {h.sol_address}</div>
                  {h.sol_signature && (
                    <a
                      href={`https://solscan.io/tx/${h.sol_signature}`}
                      target="_blank" rel="noreferrer"
                      className="num text-[10px] text-primary hover:underline inline-flex items-center gap-1 truncate"
                    >
                      {h.sol_signature.slice(0, 16)}…
                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}