import { useEffect, useMemo, useState } from "react";
import * as Relay from "@/lib/blobRelay";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Zap } from "lucide-react";
import { sha256hex, signData } from "@/lib/blob/crypto";
import { calcBalance } from "@/lib/blob/chain";
import { canonicalTxBytes, estimateTxBytes, feeFromRate, memoBytes, to8 } from "@/lib/blob/fees";
import {
  ADDR_RE, BASE_FEE_RATE, MIN_FEE_RATE, MAX_MEMO_BYTES, BLOB_DECIMALS, BLOB_UNIT,
} from "@/lib/blob/constants";

export default function SendTxForm({ wallet, chain, mempool, onBroadcast, onSent }: any) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [memo, setMemo] = useState("");
  const [st, setSt] = useState("idle");
  const [err, setErr] = useState("");
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [preset, setPreset] = useState<"slow" | "normal" | "fast" | "custom">("normal");
  const [customRate, setCustomRate] = useState<string>("");
  const balance = calcBalance(wallet.address, chain, mempool);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const info = await Relay.fetchFeeInfo();
      if (!cancelled && info) setFeeInfo(info);
    };
    load();
    const id = setInterval(load, 20_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;
  const presetRates = useMemo(() => ({
    slow: Math.max(MIN_FEE_RATE, Math.floor(recRate * 0.5)),
    normal: Math.max(MIN_FEE_RATE, recRate),
    fast: Math.max(MIN_FEE_RATE, Math.ceil(recRate * 2)),
  }), [recRate]);

  const activeFeeRate = preset === "custom"
    ? Math.max(MIN_FEE_RATE, Math.floor(Number(customRate) || 0))
    : presetRates[preset];

  useEffect(() => { setErr(""); }, [to]);

  const trimmedTo = to.trim();
  const validToAddress = ADDR_RE.test(trimmedTo) ? trimmedTo : "";

  const parsedAmt = (() => { const n = parseFloat(amt); return Number.isFinite(n) && n > 0 ? to8(n) : 0; })();
  const previewToAddress = validToAddress;
  const memoLen = memoBytes(memo);
  const memoOver = memoLen > MAX_MEMO_BYTES;
  const previewBytes = previewToAddress && parsedAmt > 0 && activeFeeRate >= MIN_FEE_RATE && !memoOver
    ? estimateTxBytes(wallet.address, previewToAddress, parsedAmt, Date.now(), activeFeeRate, memo)
    : 0;
  const previewFee = previewBytes ? feeFromRate(activeFeeRate, previewBytes) : 0;
  const previewTotal = parsedAmt + previewFee;

  async function send() {
    setErr("");
    const parsed = parseFloat(amt);
    const raw = to.trim();
    if (!raw) { setErr("Enter a recipient address"); return; }
    if (!ADDR_RE.test(raw)) { setErr("Invalid address"); return; }
    const toAddress = raw;
    if (toAddress === wallet.address) { setErr("Cannot send to yourself"); return; }
    if (!Number.isFinite(parsed) || parsed <= 0) { setErr("Invalid amount"); return; }
    const amount = to8(parsed);
    if (amount <= 0) { setErr(`Minimum amount is ${(1 / BLOB_UNIT).toFixed(BLOB_DECIMALS)} BLOB`); return; }
    if (memoOver) { setErr(`Memo too long (${memoLen}/${MAX_MEMO_BYTES} bytes)`); return; }
    if (!Number.isFinite(activeFeeRate) || activeFeeRate < MIN_FEE_RATE) {
      setErr(`Fee rate must be at least ${MIN_FEE_RATE} drops/byte`); return;
    }
    setSt("signing");
    try {
      const ts = Date.now();
      const txid = await sha256hex(`${wallet.address}${toAddress}${amount}${ts}${activeFeeRate}${memo}`);
      const data = `${wallet.address}→${toAddress}:${amount}@${ts}|fr=${activeFeeRate}|m=${memo}`;
      const sig = await signData(wallet.privateKey, data);
      const bytes = canonicalTxBytes({
        from: wallet.address, to: toAddress, amount, timestamp: ts,
        feeRate: activeFeeRate, memo, publicKey: wallet.publicKey, signature: sig,
      });
      const fee = feeFromRate(activeFeeRate, bytes);
      if (amount + fee > balance) {
        setErr(`Insufficient balance (need ${(amount + fee).toFixed(BLOB_DECIMALS)})`);
        setSt("idle"); return;
      }
      const tx = {
        id: txid.slice(0, 40),
        from: wallet.address,
        to: toAddress, amount, fee,
        feeRate: activeFeeRate, memo,
        signature: sig, publicKey: wallet.publicKey,
        timestamp: ts,
        status: "pending",
      };
      setSt("broadcasting");
      const res = await Relay.pushTx(tx);
      if (!res.ok) { setErr(res.error || "Broadcast failed"); setSt("idle"); return; }
      onBroadcast(tx);
      setSt("sent"); setTo(""); setAmt(""); setMemo("");
      setTimeout(() => { setSt("idle"); onSent?.(); }, 1500);
    } catch (e) { setErr(String(e)); setSt("idle"); }
  }

  const disabled = st !== "idle";
  const label = st === "idle" ? "Broadcast transaction"
              : st === "signing" ? "Signing…"
              : st === "broadcasting" ? "Broadcasting…"
              : "✓ Sent";

  const trimmed = to.trim();
  const looksLikeAddr = trimmed && ADDR_RE.test(trimmed);
  const unknownInput = trimmed && !looksLikeAddr;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Available</span>
        <span className="num text-primary">{balance.toFixed(BLOB_DECIMALS)} BLOB</span>
      </div>
      <div className="space-y-2">
        <label className="label-eyebrow block">Recipient</label>
        <input
          value={to}
          onChange={e => setTo(e.target.value)}
          placeholder="Recipient address (1…)"
          className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num placeholder:text-muted-foreground/60 placeholder:font-sans"
        />
        {trimmed && (
          <div className="text-[11px] min-h-[14px]">
            {looksLikeAddr && (
              <span className="text-muted-foreground">Sending to address</span>
            )}
            {unknownInput && (
              <span className="text-destructive">Not a valid address</span>
            )}
          </div>
        )}
      </div>
      <div className="space-y-2">
        <label className="label-eyebrow block">Amount</label>
        <div className="relative">
          <input
            value={amt}
            onChange={e => setAmt(e.target.value)}
            type="number"
            min="0"
            step="0.00000001"
            placeholder="0.00000000"
            className="w-full px-4 py-3 pr-20 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num placeholder:text-muted-foreground/60"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">BLOB</span>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label-eyebrow block">Memo <span className="text-muted-foreground/60">(optional)</span></label>
          <span className={`text-[10px] num ${memoOver ? "text-destructive" : "text-muted-foreground"}`}>
            {memoLen}/{MAX_MEMO_BYTES}B
          </span>
        </div>
        <input
          value={memo}
          onChange={e => setMemo(e.target.value)}
          placeholder="Note attached on-chain (e.g. invoice #1234)"
          className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm placeholder:text-muted-foreground/60"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="label-eyebrow block">Gas (network fee)</label>
          <span className="text-[10px] text-muted-foreground num">
            recommended <span className="text-primary">{recRate}</span> drops/B
          </span>
        </div>
        <Select
          value={preset}
          onValueChange={(v) => setPreset(v as "slow" | "normal" | "fast" | "custom")}
        >
          <SelectTrigger className="w-full h-10 bg-secondary/60 border-border focus:border-primary/60">
            <div className="flex items-center gap-2">
              <Zap className="h-3.5 w-3.5 text-primary" />
              <SelectValue placeholder="Select gas preset" />
            </div>
          </SelectTrigger>
          <SelectContent className="bg-popover border-border">
            <SelectItem value="slow" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Slow</span>
                <span className="text-[10px] text-muted-foreground num">{presetRates.slow} drops/B · ~10 min</span>
              </div>
            </SelectItem>
            <SelectItem value="normal" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Normal</span>
                <span className="text-[10px] text-muted-foreground num">{presetRates.normal} drops/B · ~5 min</span>
              </div>
            </SelectItem>
            <SelectItem value="fast" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Fast</span>
                <span className="text-[10px] text-muted-foreground num">{presetRates.fast} drops/B · ~2 min</span>
              </div>
            </SelectItem>
            <SelectItem value="custom" className="cursor-pointer">
              <div className="flex flex-col py-0.5">
                <span className="text-sm font-medium">Custom</span>
                <span className="text-[10px] text-muted-foreground num">Set your own rate</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>

        {preset === "custom" && (
          <div className="relative">
            <input
              value={customRate}
              onChange={e => setCustomRate(e.target.value)}
              type="number"
              min={MIN_FEE_RATE}
              step="1"
              placeholder={String(recRate)}
              className="w-full px-3 py-2 pr-16 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm num"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">drops/B</span>
          </div>
        )}
      </div>

      <div className="glass px-3 py-2 text-xs space-y-1">
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Fee rate</span>
          <span className="num">{activeFeeRate} drops/B</span>
        </div>
        <div className="flex items-center justify-between text-muted-foreground">
          <span>Tx size (est.)</span>
          <span className="num">{previewBytes || "—"} B</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Network fee</span>
          <span className="num text-foreground">{previewFee.toFixed(BLOB_DECIMALS)} BLOB</span>
        </div>
        <div className="flex items-center justify-between border-t border-border/60 pt-1 mt-1">
          <span className="text-muted-foreground">Total</span>
          <span className="num text-primary">{previewTotal.toFixed(BLOB_DECIMALS)} BLOB</span>
        </div>
      </div>

      {err && <div className="text-xs text-destructive">{err}</div>}
      {st === "sent" && <div className="text-xs text-primary">✓ Broadcast to mempool</div>}
      <button
        onClick={send}
        disabled={disabled || memoOver}
        className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition"
      >
        {label}
      </button>
    </div>
  );
}
