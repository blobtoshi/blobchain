import { useState } from "react";
import { Trophy, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { calcBalance } from "@/lib/blob/chain";
import { BLOB_DECIMALS, TX_FEE } from "@/lib/blob/constants";
import SendTxForm from "./SendTxForm";

export default function WalletScreen({ wallet, chain, mempool, onBroadcast }: any) {
  const [copied, setCopied] = useState(false);
  const balance = calcBalance(wallet.address, chain, mempool);
  const pending = mempool
    .filter((tx: any) => tx.to === wallet.address)
    .reduce((s: number, tx: any) => s + tx.amount, 0);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const history = (() => {
    const items: any[] = [];
    for (const b of chain) {
      if (b.winner === wallet.address && (b.reward || 0) > 0) {
        items.push({
          kind: "reward",
          amount: b.reward,
          counterparty: `Block #${b.height}`,
          ts: b.timestamp,
          status: "confirmed",
          id: `r-${b.height}`,
        });
      }
      for (const tx of (b.transactions || [])) {
        if (tx.to === wallet.address || tx.from === wallet.address) {
          items.push({
            kind: tx.from === wallet.address ? "send" : "receive",
            amount: tx.amount,
            fee: tx.fee || TX_FEE,
            counterparty: tx.from === wallet.address ? tx.to : (tx.from === "coinbase" ? "blob" : tx.from),
            ts: tx.timestamp,
            status: "confirmed",
            id: tx.id,
            memo: tx.memo || "",
          });
        }
      }
    }
    for (const tx of mempool) {
      if (tx.to === wallet.address || tx.from === wallet.address) {
        items.push({
          kind: tx.from === wallet.address ? "send" : "receive",
          amount: tx.amount,
          fee: tx.fee || TX_FEE,
          counterparty: tx.from === wallet.address ? tx.to : (tx.from === "coinbase" ? "blob" : tx.from),
          ts: tx.timestamp,
          status: "pending",
          id: tx.id,
          memo: tx.memo || "",
        });
      }
    }
    return items.sort((a, b) => b.ts - a.ts);
  })();

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-3xl glass-pane px-5 sm:px-8 py-8 sm:py-10">
        <div className="pointer-events-none absolute -top-32 right-0 w-[420px] h-[420px] rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="label-eyebrow">Balance</span>
              </div>
              <div className="num text-4xl sm:text-6xl font-semibold leading-none text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.4)]">
                {balance.toFixed(BLOB_DECIMALS)}
                <span className="text-base sm:text-lg text-muted-foreground ml-2 font-normal">BLOB</span>
              </div>
              {pending > 0 && (
                <div className="text-xs text-muted-foreground num mt-2">+{pending.toFixed(BLOB_DECIMALS)} incoming</div>
              )}
            </div>
            <div className="flex items-center gap-2 max-w-full">
              <div className="flex items-center gap-2 px-3 py-2 rounded-full border border-border bg-card/50 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))] shrink-0" />
                <span className="num text-xs text-foreground/80 truncate">{wallet.address}</span>
              </div>
              <button
                onClick={copy}
                className="px-3 py-2 rounded-full text-xs border border-border hover:border-primary/40 hover:text-primary transition shrink-0"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-1 order-1 lg:order-2">
          <div className="glass-hi p-5 sm:p-6 lg:sticky lg:top-20">
            <div className="label-eyebrow mb-4">Send BLOB</div>
            <SendTxForm wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onBroadcast} />
          </div>
        </div>

        <div className="lg:col-span-2 order-2 lg:order-1 space-y-2">
          <div className="label-eyebrow px-1">Transaction history</div>
          {history.length === 0 ? (
            <div className="glass px-5 py-10 text-center text-sm text-muted-foreground">
              No transactions yet — mine a block or send some BLOB to see history here
            </div>
          ) : (
            <div className="space-y-1.5">
              {history.map((h) => {
                const isOut = h.kind === "send";
                const isReward = h.kind === "reward";
                const Icon = isReward ? Trophy : isOut ? ArrowUpRight : ArrowDownLeft;
                const color = isReward
                  ? "text-[hsl(var(--warning))]"
                  : isOut
                    ? "text-destructive"
                    : "text-primary";
                const sign = isOut ? "−" : "+";
                return (
                  <div key={h.id} className="glass px-4 py-3 flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full border border-border bg-card/50 flex items-center justify-center ${color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">
                          {isReward ? "Block reward" : isOut ? "Sent" : "Received"}
                        </span>
                        {h.status === "pending" && (
                          <span className="text-[10px] tracking-wide uppercase px-1.5 py-0.5 rounded-full border border-border text-muted-foreground">
                            Pending
                          </span>
                        )}
                      </div>
                      <div className="num text-xs text-muted-foreground truncate">
                        {isReward ? h.counterparty : (isOut ? "to " : "from ") + h.counterparty}
                      </div>
                      {h.memo && (
                        <div className="text-[11px] text-foreground/70 italic truncate mt-0.5">
                          “{h.memo}”
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`num text-sm font-semibold ${color}`}>
                        {sign}{Number(h.amount).toFixed(4)}
                      </div>
                      <div className="num text-[10px] text-muted-foreground">
                        {new Date(h.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
