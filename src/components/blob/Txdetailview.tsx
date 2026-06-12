// Dedicated transaction detail view. Renders as a full-takeover
// panel inside the BlockExplorer when a tx is selected. Shows everything
// known about the tx: status, amount, fee breakdown, memo, signatures,
// timestamps, block context, and an event-style timeline of what happened.

import { ArrowLeft, Copy, Check, ExternalLink, HandCoins, Send, ArrowUpRight, ArrowDownLeft, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { ExplorerTx } from "@/lib/blob/explorer";
import { shortHash } from "@/lib/blob/explorer";
import { BLOB_DECIMALS } from "@/lib/blob/constants";

type Props = {
  tx: ExplorerTx;
  block?: any;
  chainTipHeight?: number;
  onBack: () => void;
  onSelectAddr: (addr: string) => void;
  onSelectBlock: (height: number) => void;
};

function CopyBtn({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition px-1.5 py-0.5 rounded border border-border hover:border-primary/40"
      title={label ? `Copy ${label}` : "Copy"}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function Row({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] gap-1 sm:gap-4 py-3 border-b border-border/50 last:border-0">
      <div className="label-eyebrow text-muted-foreground self-start pt-0.5">{label}</div>
      <div className={`min-w-0 ${mono ? "num text-foreground/80 break-all" : "text-foreground/90"}`}>
        {children}
      </div>
    </div>
  );
}

export default function TxDetailView({ tx, block, chainTipHeight, onBack, onSelectAddr, onSelectBlock }: Props) {
  const isReward = tx.kind === "reward";
  const isPending = tx.status === "pending";
  const total = tx.amount + tx.fee;
  const confirmations = !isPending && chainTipHeight && tx.block != null
    ? Math.max(0, chainTipHeight - tx.block + 1)
    : 0;

  const StatusIcon = isPending ? Clock : CheckCircle2;
  const statusColor = isPending ? "text-[hsl(var(--warning))]" : "text-primary";
  const statusBg    = isPending ? "bg-[hsl(var(--warning))]/10" : "bg-primary/10";
  const statusBorder = isPending ? "border-[hsl(var(--warning))]/40" : "border-primary/40";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border hover:border-primary/40 hover:text-primary transition text-xs"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back
        </button>
        <span className="label-eyebrow text-muted-foreground">// TRANSACTION</span>
      </div>

      {/* Hero summary card */}
      <div className="glass-hi p-5 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-12 h-12 rounded-full ${statusBg} ${statusBorder} border flex items-center justify-center shrink-0`}>
              {isReward ? (
                <HandCoins className={`w-5 h-5 ${statusColor}`} />
              ) : (
                <Send className={`w-5 h-5 ${statusColor}`} />
              )}
            </div>
            <div className="min-w-0">
              <div className="text-lg font-semibold">
                {isReward ? "Block Reward" : "Transfer"}
              </div>
              <div className="num text-xs text-muted-foreground truncate">
                {tx.id}
              </div>
            </div>
          </div>
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full ${statusBg} ${statusBorder} border ${statusColor} text-xs font-medium`}>
            <StatusIcon className="w-3.5 h-3.5" />
            {isPending ? "Pending" : "Confirmed"}
            {!isPending && confirmations > 0 && (
              <span className="num text-muted-foreground ml-1">· {confirmations} conf</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border border-border bg-card/30 p-3">
            <div className="label-eyebrow text-muted-foreground mb-1">AMOUNT</div>
            <div className="num text-2xl font-semibold text-primary">
              {tx.amount.toFixed(BLOB_DECIMALS)} <span className="text-sm font-normal text-muted-foreground">BLOB</span>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-card/30 p-3">
            <div className="label-eyebrow text-muted-foreground mb-1">FEE</div>
            <div className="num text-2xl font-semibold">
              {tx.fee.toFixed(BLOB_DECIMALS)} <span className="text-sm font-normal text-muted-foreground">BLOB</span>
            </div>
            {tx.feeRate != null && (
              <div className="num text-[10px] text-muted-foreground mt-0.5">
                @ {tx.feeRate} drops/byte
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-card/30 p-3">
            <div className="label-eyebrow text-muted-foreground mb-1">TOTAL DEDUCTED</div>
            <div className="num text-2xl font-semibold">
              {total.toFixed(BLOB_DECIMALS)} <span className="text-sm font-normal text-muted-foreground">BLOB</span>
            </div>
          </div>
        </div>
      </div>

      {/* Details section */}
      <div className="glass p-5 sm:p-6">
        <div className="label-eyebrow mb-3">// DETAILS</div>
        <div className="space-y-0">
          <Row label="Signature">
            <div className="flex items-start gap-2 flex-wrap">
              <span className="num text-foreground/80 break-all text-xs">{tx.id}</span>
              <CopyBtn value={tx.id} label="signature" />
            </div>
          </Row>

          <Row label="Status">
            <div className="flex items-center gap-2">
              {isPending ? (
                <>
                  <Clock className="w-3.5 h-3.5 text-[hsl(var(--warning))]" />
                  <span>Pending in mempool</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                  <span>Confirmed</span>
                  {confirmations > 0 && (
                    <span className="num text-xs text-muted-foreground">({confirmations} confirmation{confirmations === 1 ? "" : "s"})</span>
                  )}
                </>
              )}
            </div>
          </Row>

          {!isPending && tx.block != null && (
            <Row label="Block">
              <button
                onClick={() => onSelectBlock(tx.block!)}
                className="num text-primary hover:underline"
              >
                #{tx.block}
              </button>
            </Row>
          )}

          <Row label="Timestamp">
            <div className="flex items-center gap-2 flex-wrap">
              <span>{new Date(tx.timestamp).toLocaleString()}</span>
              <span className="num text-xs text-muted-foreground">({tx.timestamp})</span>
            </div>
          </Row>

          <Row label={isReward ? "Reward to" : "From"}>
            {isReward ? (
              <span className="text-muted-foreground italic">Block reward (coinbase)</span>
            ) : tx.from === "coinbase" ? (
              <span className="text-muted-foreground italic">coinbase</span>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => onSelectAddr(tx.from)}
                  className="num text-[hsl(var(--warning))] hover:underline text-left break-all"
                >
                  {tx.from}
                </button>
                <CopyBtn value={tx.from} label="address" />
              </div>
            )}
          </Row>

          <Row label={isReward ? "Winner" : "To"}>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => onSelectAddr(tx.to)}
                className="num text-[hsl(var(--warning))] hover:underline text-left break-all"
              >
                {tx.to}
              </button>
              <CopyBtn value={tx.to} label="address" />
            </div>
          </Row>

          <Row label="Amount">
            <span className="num text-primary">{tx.amount.toFixed(BLOB_DECIMALS)} BLOB</span>
          </Row>

          <Row label="Network fee">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="num">{tx.fee.toFixed(BLOB_DECIMALS)} BLOB</span>
              {tx.feeRate != null && (
                <span className="num text-xs text-muted-foreground">
                  ({tx.feeRate} drops/byte)
                </span>
              )}
            </div>
          </Row>

          {tx.memo && (
            <Row label="Memo">
              <span className="text-foreground/90 break-words italic">"{tx.memo}"</span>
            </Row>
          )}

          {tx.signature && (
            <Row label="Witness sig">
              <div className="flex items-start gap-2 flex-wrap">
                <span className="num text-foreground/60 break-all text-[11px]">{tx.signature}</span>
                <CopyBtn value={tx.signature} label="signature" />
              </div>
            </Row>
          )}
        </div>
      </div>

      {/* Token transfer summary (Solscan-style) */}
      {!isReward && (
        <div className="glass p-5 sm:p-6">
          <div className="label-eyebrow mb-3">// TOKEN BALANCE CHANGES</div>
          <div className="space-y-2">
            <div className="grid grid-cols-[40px_1fr_auto] gap-3 items-center py-2 border-b border-border/50">
              <div className="w-8 h-8 rounded-full bg-destructive/10 border border-destructive/40 flex items-center justify-center">
                <ArrowUpRight className="w-3.5 h-3.5 text-destructive" />
              </div>
              <div className="min-w-0">
                <div className="text-xs label-eyebrow text-muted-foreground">SENDER</div>
                <button
                  onClick={() => onSelectAddr(tx.from)}
                  className="num text-xs text-[hsl(var(--warning))] hover:underline truncate block text-left"
                >
                  {shortHash(tx.from, 10)}
                </button>
              </div>
              <div className="num text-destructive whitespace-nowrap">
                −{total.toFixed(BLOB_DECIMALS)} BLOB
              </div>
            </div>
            <div className="grid grid-cols-[40px_1fr_auto] gap-3 items-center py-2">
              <div className="w-8 h-8 rounded-full bg-primary/10 border border-primary/40 flex items-center justify-center">
                <ArrowDownLeft className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="text-xs label-eyebrow text-muted-foreground">RECIPIENT</div>
                <button
                  onClick={() => onSelectAddr(tx.to)}
                  className="num text-xs text-[hsl(var(--warning))] hover:underline truncate block text-left"
                >
                  {shortHash(tx.to, 10)}
                </button>
              </div>
              <div className="num text-primary whitespace-nowrap">
                +{tx.amount.toFixed(BLOB_DECIMALS)} BLOB
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Block context (only for confirmed transfers/rewards) */}
      {!isPending && block && (
        <div className="glass p-5 sm:p-6">
          <div className="label-eyebrow mb-3">// BLOCK CONTEXT</div>
          <div className="space-y-0">
            <Row label="Height">
              <button onClick={() => onSelectBlock(block.height)} className="num text-primary hover:underline">
                #{block.height}
              </button>
            </Row>
            {block.hash && (
              <Row label="Block hash" mono>
                <div className="flex items-start gap-2 flex-wrap">
                  <span className="break-all text-xs">{block.hash}</span>
                  <CopyBtn value={block.hash} />
                </div>
              </Row>
            )}
            {block.winner && (
              <Row label="Winner">
                <button
                  onClick={() => onSelectAddr(block.winner)}
                  className="num text-[hsl(var(--warning))] hover:underline break-all text-left"
                >
                  {block.winner}
                </button>
              </Row>
            )}
            {block.winnerScore != null && (
              <Row label="Winning score">
                <span className="num">{Number(block.winnerScore).toLocaleString()}</span>
              </Row>
            )}
            <Row label="Block reward">
              <span className="num">{Number(block.reward ?? 0).toFixed(BLOB_DECIMALS)} BLOB</span>
            </Row>
            <Row label="Block tx count">
              <span className="num">{(block.transactions ?? []).length}</span>
            </Row>
          </div>
        </div>
      )}

      {isPending && (
        <div className="glass p-4 flex items-start gap-3 border-l-2 border-[hsl(var(--warning))]/60">
          <AlertTriangle className="w-4 h-4 text-[hsl(var(--warning))] shrink-0 mt-0.5" />
          <div className="text-xs text-foreground/80">
            <div className="font-semibold mb-0.5">This transaction is pending.</div>
            <div className="text-muted-foreground">
              It has been broadcast to the mempool and is waiting to be included in the next block (~120 seconds).
            </div>
          </div>
        </div>
      )}
    </div>
  );
}