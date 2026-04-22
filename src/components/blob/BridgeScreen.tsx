// @ts-nocheck
import { useEffect, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeftRight, ExternalLink, Loader2, CheckCircle2, AlertCircle, Copy,
} from "lucide-react";
import { sha256hex, signData } from "@/lib/blob/crypto";
import { calcBalance } from "@/lib/blob/chain";
import { canonicalTxBytes, estimateTxBytes, feeFromRate, memoBytes, to8 } from "@/lib/blob/fees";
import {
  BASE_FEE_RATE, MIN_FEE_RATE, MAX_MEMO_BYTES, BLOB_DECIMALS, SOL_ADDR_RE,
} from "@/lib/blob/constants";

export default function BridgeScreen({ wallet, chain, mempool, onBroadcast }: any) {
  const [config, setConfig] = useState<{ bridgeAddress: string; splMintAddress: string | null } | null>(null);
  const [solAddr, setSolAddr] = useState("");
  const [amt, setAmt] = useState("");
  const [st, setSt] = useState<"idle" | "signing" | "broadcasting" | "registering" | "waiting" | "minting" | "minted" | "failed">("idle");
  const [err, setErr] = useState("");
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [activeRequest, setActiveRequest] = useState<Relay.BridgeRequest | null>(null);
  const [history, setHistory] = useState<Relay.BridgeRequest[]>([]);
  const [copied, setCopied] = useState(false);

  const balance = calcBalance(wallet.address, chain, mempool);

  useEffect(() => {
    let cancelled = false;
    let cfgTimer: any = null;
    const loadConfig = async () => {
      const cfg = await Relay.fetchBridgeConfig();
      if (cancelled) return;
      if (cfg) setConfig(cfg);
      else cfgTimer = setTimeout(loadConfig, 2000);
    };
    (async () => {
      const [fi, hist] = await Promise.all([
        Relay.fetchFeeInfo(),
        Relay.fetchBridgeHistory(wallet.address),
      ]);
      if (cancelled) return;
      if (fi) setFeeInfo(fi);
      setHistory(hist);
    })();
    loadConfig();
    const id = setInterval(async () => {
      const hist = await Relay.fetchBridgeHistory(wallet.address);
      if (!cancelled) setHistory(hist);
    }, 15_000);
    return () => { cancelled = true; clearInterval(id); if (cfgTimer) clearTimeout(cfgTimer); };
  }, [wallet.address]);

  useEffect(() => {
    const currentDone = !activeRequest || activeRequest.status === "minted" || activeRequest.status === "failed";
    if (!currentDone) return;
    const inflight = history.find((h) => h.status === "pending" || h.status === "confirmed" || h.status === "minting");
    if (!inflight) return;
    setActiveRequest(inflight);
    setSt(inflight.status === "minting" || inflight.status === "confirmed" ? "minting" : "waiting");
  }, [history, activeRequest]);

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
      if (r.status === "minted") setSt("minted");
      else if (r.status === "failed") { setSt("failed"); setErr(r.error || "Mint failed"); }
      else if (r.status === "minting") setSt("minting");
      else if (r.status === "confirmed") setSt("minting");
      else setSt("waiting");
    };

    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [activeRequest?.blob_tx_id, activeRequest?.status]);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;
  const activeFeeRate = Math.max(MIN_FEE_RATE, recRate);
  const parsedAmt = (() => { const n = parseFloat(amt); return Number.isFinite(n) && n > 0 ? to8(n) : 0; })();
  const memoStr = solAddr.trim() ? `sol:${solAddr.trim()}` : "";
  const memoLen = memoBytes(memoStr);
  const memoOver = memoLen > MAX_MEMO_BYTES;
  const previewBytes = config && parsedAmt > 0 && !memoOver
    ? estimateTxBytes(wallet.address, config.bridgeAddress, parsedAmt, Date.now(), activeFeeRate, memoStr)
    : 0;
  const previewFee = previewBytes ? feeFromRate(activeFeeRate, previewBytes) : 0;
  const previewTotal = parsedAmt + previewFee;

  const validSol = SOL_ADDR_RE.test(solAddr.trim());
  const canSubmit =
    !!config && st === "idle" && validSol && parsedAmt > 0 && !memoOver && previewTotal <= balance;

  async function bridge() {
    setErr("");
    if (!config) { setErr("Bridge not configured"); return; }
    if (!validSol) { setErr("Invalid Solana address"); return; }
    if (parsedAmt <= 0) { setErr("Invalid amount"); return; }
    if (memoOver) { setErr(`Memo too long (${memoLen}/${MAX_MEMO_BYTES})`); return; }
    if (previewTotal > balance) { setErr("Insufficient balance"); return; }

    setSt("signing");
    try {
      const ts = Date.now();
      const txid = (await sha256hex(`${wallet.address}${config.bridgeAddress}${parsedAmt}${ts}${activeFeeRate}${memoStr}`)).slice(0, 40);
      const data = `${wallet.address}→${config.bridgeAddress}:${parsedAmt}@${ts}|fr=${activeFeeRate}|m=${memoStr}`;
      const sig = await signData(wallet.privateKey, data);
      const bytes = canonicalTxBytes({
        from: wallet.address, to: config.bridgeAddress, amount: parsedAmt, timestamp: ts,
        feeRate: activeFeeRate, memo: memoStr, publicKey: wallet.publicKey, signature: sig,
      });
      const fee = feeFromRate(activeFeeRate, bytes);
      const tx = {
        id: txid,
        from: wallet.address, fromUsername: wallet.username,
        to: config.bridgeAddress, amount: parsedAmt, fee,
        feeRate: activeFeeRate, memo: memoStr,
        signature: sig, publicKey: wallet.publicKey,
        timestamp: ts, status: "pending",
      };

      setSt("broadcasting");
      const res = await Relay.pushTx(tx);
      if (!res.ok) { setErr(res.error || "Broadcast failed"); setSt("failed"); return; }
      onBroadcast(tx);

      setSt("registering");
      const reg = await Relay.registerBridgeRequest({
        blob_tx_id: txid,
        sol_address: solAddr.trim(),
        amount: parsedAmt,
        from_address: wallet.address,
        from_username: wallet.username,
      });
      if (!reg.ok || !reg.data) { setErr(reg.error || "Bridge registration failed"); setSt("failed"); return; }
      setActiveRequest(reg.data);
      setSt(reg.data.status === "minted" ? "minted"
         : reg.data.status === "minting" ? "minting"
         : reg.data.status === "confirmed" ? "minting"
         : "waiting");
      setAmt(""); setSolAddr("");
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

  const StatusPill = ({ status }: { status: Relay.BridgeRequest["status"] }) => {
    const map = {
      pending:   { text: "Waiting for block",  cls: "text-muted-foreground border-border" },
      confirmed: { text: "Confirmed on Blob",  cls: "text-primary border-primary/40" },
      minting:   { text: "Minting on Solana",  cls: "text-primary border-primary/40" },
      minted:    { text: "Minted",             cls: "text-[hsl(var(--success,142_70%_45%))] border-[hsl(var(--success,142_70%_45%))]/40" },
      failed:    { text: "Failed",             cls: "text-destructive border-destructive/40" },
    } as const;
    const m = map[status];
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${m.cls}`}>
        {status === "minted" ? <CheckCircle2 className="w-3 h-3" />
         : status === "failed" ? <AlertCircle className="w-3 h-3" />
         : <Loader2 className="w-3 h-3 animate-spin" />}
        {m.text}
      </span>
    );
  };

  return (
    <div className="space-y-5">
      {/* Hero */}
      <div className="relative overflow-hidden rounded-3xl glass-hi px-5 sm:px-8 py-8 sm:py-10">
        <div className="pointer-events-none absolute -top-32 right-0 w-[420px] h-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 border border-primary/30 text-primary">
              <ArrowLeftRight className="w-4 h-4" />
            </div>
            <span className="label-eyebrow">Bridge</span>
          </div>
          <h1 className="text-2xl sm:text-4xl font-semibold tracking-tight">
            <span className="text-foreground">Bridge </span>
            <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)]">BLOB</span>
            <span className="text-foreground"> to Solana</span>
          </h1>
          <div className="text-sm text-muted-foreground max-w-xl leading-relaxed">
            Send BLOB to the bridge address — we mint the same amount of Wrapped BLOB to your Solana wallet 1:1, no bridge fee. You only pay the network fee on Blob Chain.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Form */}
        <div className="lg:col-span-2 space-y-4">
          <div className="glass-hi p-5 sm:p-6 space-y-4">
            <div className="label-eyebrow">Bridge BLOB → WBLOB</div>

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
              <div className="text-[10px] text-muted-foreground">
                Funds sent here are bridged automatically — never send manually from another wallet.
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                Solana recipient address
              </Label>
              <Input
                value={solAddr}
                onChange={(e) => setSolAddr(e.target.value)}
                placeholder="e.g. 7xKXtg2C…  (base58, 32-44 chars)"
                className="num text-xs"
                spellCheck={false}
                autoComplete="off"
                disabled={st !== "idle" && st !== "failed" && st !== "minted"}
              />
              {solAddr.trim() && !validSol && (
                <div className="text-[10px] text-destructive">Not a valid Solana address</div>
              )}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                  Amount
                </Label>
                <button
                  type="button"
                  onClick={() => setAmt(Math.max(0, balance - (previewFee || 0.0001)).toFixed(BLOB_DECIMALS))}
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
                  <span className="num">{parsedAmt.toFixed(BLOB_DECIMALS)} SPL</span>
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
                <><ArrowLeftRight className="w-4 h-4" /> Bridge to Solana</>
              ) : st === "signing" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Signing…</>
              ) : st === "broadcasting" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Broadcasting…</>
              ) : st === "registering" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Registering bridge…</>
              ) : st === "waiting" ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Waiting for block…</>
              ) : (
                <><Loader2 className="w-4 h-4 animate-spin" /> Minting on Solana…</>
              )}
            </button>
          </div>

          {activeRequest && (
            <div className="glass-hi p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="label-eyebrow">Latest bridge</div>
                <StatusPill status={activeRequest.status} />
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

        {/* History */}
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
                    <StatusPill status={h.status} />
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
    </div>
  );
}
