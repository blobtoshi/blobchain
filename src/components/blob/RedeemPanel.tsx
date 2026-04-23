// @ts-nocheck
// WBLOB → BLOB reverse bridge UI.
// User connects a Solana wallet and signs ONE tx that:
//   - Burns `amount` WBLOB from their associated token account.
//   - Includes a Memo program ix `blob:<dest>` binding the destination Blob address.
// We POST { sol_signature, blob_address, amount } to bridge-redeem and poll.
import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  createBurnCheckedInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeftRight, ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import * as Relay from "@/lib/blobRelay";
import {
  ADDR_RE, BLOB_DECIMALS, BRIDGE_FEE_BLOB, MEMO_PROGRAM_ID,
} from "@/lib/blob/constants";
import { to8 } from "@/lib/blob/fees";

type Status = "idle" | "preparing" | "signing" | "broadcasting" | "registering" | "verifying" | "crediting" | "credited" | "failed";

export default function RedeemPanel({
  splMintAddress,
  defaultBlobAddress,
}: {
  splMintAddress: string | null;
  defaultBlobAddress?: string;
}) {
  const { connection } = useConnection();
  const { publicKey, signTransaction, connected } = useWallet();
  const [blobAddr, setBlobAddr] = useState(defaultBlobAddress ?? "");
  const [amt, setAmt] = useState("");
  const [st, setSt] = useState<Status>("idle");
  const [err, setErr] = useState("");
  const [active, setActive] = useState<Relay.RedeemRequest | null>(null);
  const [history, setHistory] = useState<Relay.RedeemRequest[]>([]);
  const [splBalance, setSplBalance] = useState<number | null>(null);

  const parsedAmt = useMemo(() => {
    const n = parseFloat(amt);
    return Number.isFinite(n) && n > 0 ? to8(n) : 0;
  }, [amt]);
  const validBlob = ADDR_RE.test(blobAddr.trim());
  const credit = parsedAmt > 0 ? Math.max(0, to8(parsedAmt - BRIDGE_FEE_BLOB)) : 0;
  const canSubmit =
    !!splMintAddress && connected && st === "idle" && validBlob && parsedAmt > BRIDGE_FEE_BLOB;

  // Load balance on connect / mint change.
  useEffect(() => {
    let cancelled = false;
    setSplBalance(null);
    if (!publicKey || !splMintAddress) return;
    (async () => {
      try {
        const mintPub = new PublicKey(splMintAddress);
        const ata = await getAssociatedTokenAddress(mintPub, publicKey, true);
        const bal = await connection.getTokenAccountBalance(ata).catch(() => null);
        if (!cancelled) setSplBalance(bal?.value?.uiAmount ?? 0);
      } catch {
        if (!cancelled) setSplBalance(0);
      }
    })();
    return () => { cancelled = true; };
  }, [publicKey, splMintAddress, connection, active?.status]);

  // History — public, filtered by destination blob address.
  useEffect(() => {
    if (!validBlob) { setHistory([]); return; }
    let cancelled = false;
    const load = async () => {
      const h = await Relay.fetchRedeemHistory(blobAddr.trim());
      if (!cancelled) setHistory(h);
    };
    load();
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [blobAddr, validBlob, active?.status]);

  // Poll active redemption.
  useEffect(() => {
    if (!active) return;
    if (active.status === "credited" || active.status === "failed") return;
    let cancelled = false;
    const poll = async () => {
      const r = await Relay.pollRedeem(active.sol_signature);
      if (!r || cancelled) return;
      setActive(r);
      setHistory((prev) => {
        const next = prev.filter((x) => x.sol_signature !== r.sol_signature);
        return [r, ...next];
      });
      if (r.status === "credited") setSt("credited");
      else if (r.status === "failed") { setSt("failed"); setErr(r.error || "Redemption failed"); }
      else if (r.status === "crediting") setSt("crediting");
      else if (r.status === "verified") setSt("crediting");
      else setSt("verifying");
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [active?.sol_signature, active?.status]);

  function reset() { setSt("idle"); setErr(""); setActive(null); }

  async function redeem() {
    setErr("");
    if (!splMintAddress) { setErr("Bridge not configured"); return; }
    if (!publicKey || !signTransaction) { setErr("Connect a Solana wallet"); return; }
    if (!validBlob) { setErr("Invalid Blob destination address"); return; }
    if (parsedAmt <= BRIDGE_FEE_BLOB) { setErr(`Amount must exceed bridge fee (${BRIDGE_FEE_BLOB} BLOB)`); return; }

    try {
      setSt("preparing");
      const mintPub = new PublicKey(splMintAddress);
      const mintInfo = await getMint(connection, mintPub);
      const ata = await getAssociatedTokenAddress(mintPub, publicKey, true);
      const baseUnits = BigInt(Math.round(parsedAmt * 10 ** mintInfo.decimals));
      if (baseUnits <= 0n) { setErr("Amount rounds to zero"); setSt("failed"); return; }

      const burnIx = createBurnCheckedInstruction(
        ata, mintPub, publicKey, baseUnits, mintInfo.decimals,
      );
      const memoIx = new TransactionInstruction({
        keys: [{ pubkey: publicKey, isSigner: true, isWritable: false }],
        programId: new PublicKey(MEMO_PROGRAM_ID),
        data: Buffer.from(`blob:${blobAddr.trim()}`, "utf8"),
      });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight })
        .add(memoIx).add(burnIx);

      setSt("signing");
      const signed = await signTransaction(tx);

      setSt("broadcasting");
      const sig = await connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false, maxRetries: 3,
      });

      setSt("registering");
      const reg = await Relay.registerRedeem({
        sol_signature: sig,
        blob_address: blobAddr.trim(),
        amount: parsedAmt,
      });
      if (!reg.ok || !reg.data) { setErr(reg.error || "Register failed"); setSt("failed"); return; }
      setActive(reg.data);
      setSt("verifying");
      setAmt("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
      setSt("failed");
    }
  }

  const StatusPill = ({ status }: { status: Relay.RedeemRequest["status"] }) => {
    const map = {
      pending:   { text: "Verifying burn",    cls: "text-muted-foreground border-border" },
      verified:  { text: "Verified",           cls: "text-primary border-primary/40" },
      crediting: { text: "Crediting BLOB",     cls: "text-primary border-primary/40" },
      credited:  { text: "Credited",           cls: "text-[hsl(var(--success,142_70%_45%))] border-[hsl(var(--success,142_70%_45%))]/40" },
      failed:    { text: "Failed",             cls: "text-destructive border-destructive/40" },
    } as const;
    const m = map[status];
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${m.cls}`}>
        {status === "credited" ? <CheckCircle2 className="w-3 h-3" />
         : status === "failed" ? <AlertCircle className="w-3 h-3" />
         : <Loader2 className="w-3 h-3 animate-spin" />}
        {m.text}
      </span>
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        <div className="glass-hi p-5 sm:p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="label-eyebrow">Redeem WBLOB → BLOB</div>
            <WalletMultiButton style={{
              background: "hsl(var(--primary))",
              color: "hsl(var(--primary-foreground))",
              fontSize: 12, height: 32, lineHeight: "32px", padding: "0 12px",
              borderRadius: 9999, fontWeight: 600,
            }} />
          </div>

          {connected && publicKey && (
            <div className="text-[11px] text-muted-foreground flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
              <span className="num truncate">{publicKey.toBase58()}</span>
              <span className="num shrink-0 ml-2">
                {splBalance == null ? "…" : `${splBalance.toFixed(BLOB_DECIMALS)} WBLOB`}
              </span>
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
              Blob destination address
            </Label>
            <Input
              value={blobAddr}
              onChange={(e) => setBlobAddr(e.target.value)}
              placeholder="1…"
              className="num text-xs"
              spellCheck={false}
              autoComplete="off"
              disabled={st !== "idle" && st !== "failed" && st !== "credited"}
            />
            {blobAddr.trim() && !validBlob && (
              <div className="text-[10px] text-destructive">Not a valid Blob address</div>
            )}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                Amount
              </Label>
              {splBalance != null && splBalance > 0 && (
                <button
                  type="button"
                  onClick={() => setAmt(splBalance.toFixed(BLOB_DECIMALS))}
                  className="text-[10px] text-muted-foreground hover:text-primary transition"
                >
                  Max: <span className="num">{splBalance.toFixed(BLOB_DECIMALS)}</span>
                </button>
              )}
            </div>
            <div className="relative">
              <Input
                value={amt}
                onChange={(e) => setAmt(e.target.value)}
                placeholder="0.00000000"
                inputMode="decimal"
                className="num pr-20"
                disabled={st !== "idle" && st !== "failed" && st !== "credited"}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                WBLOB
              </span>
            </div>
          </div>

          {parsedAmt > 0 && (
            <div className="rounded-lg border border-border bg-card/30 p-3 text-[11px] space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-foreground">You burn</span>
                <span className="num">{parsedAmt.toFixed(BLOB_DECIMALS)} WBLOB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bridge fee</span>
                <span className="num">{BRIDGE_FEE_BLOB.toFixed(BLOB_DECIMALS)} BLOB</span>
              </div>
              <div className="flex justify-between border-t border-border pt-1 mt-1 text-primary">
                <span>You receive on Blob Chain</span>
                <span className="num font-medium">{credit.toFixed(BLOB_DECIMALS)} BLOB</span>
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
            onClick={redeem}
            disabled={!canSubmit}
            className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold tracking-wide hover:bg-primary/90 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
          >
            {st === "idle" || st === "credited" || st === "failed" ? (
              <><ArrowLeftRight className="w-4 h-4" /> {connected ? "Burn & Redeem" : "Connect wallet"}</>
            ) : st === "preparing" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Preparing tx…</>
            ) : st === "signing" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Awaiting signature…</>
            ) : st === "broadcasting" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Broadcasting on Solana…</>
            ) : st === "registering" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Registering…</>
            ) : st === "verifying" ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Awaiting finalization…</>
            ) : (
              <><Loader2 className="w-4 h-4 animate-spin" /> Crediting BLOB…</>
            )}
          </button>

          <div className="text-[10px] text-muted-foreground leading-relaxed">
            The burn is final — the bridge fee covers the Blob Chain network fee for your credit transaction.
            Finalization on Solana typically takes ~15 seconds before crediting starts.
          </div>
        </div>

        {active && (
          <div className="glass-hi p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="label-eyebrow">Latest redemption</div>
              <StatusPill status={active.status} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div>
                <div className="text-muted-foreground mb-0.5">Burned</div>
                <div className="num text-foreground">{Number(active.amount).toFixed(BLOB_DECIMALS)} WBLOB</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-0.5">Will receive</div>
                <div className="num text-foreground">
                  {active.credit_amount != null
                    ? `${Number(active.credit_amount).toFixed(BLOB_DECIMALS)} BLOB`
                    : "—"}
                </div>
              </div>
              <div className="col-span-2">
                <div className="text-muted-foreground mb-0.5">Solana signature</div>
                <a
                  href={`https://solscan.io/tx/${active.sol_signature}`}
                  target="_blank" rel="noreferrer"
                  className="num text-primary hover:underline inline-flex items-center gap-1 truncate"
                >
                  {active.sol_signature}
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              </div>
              {active.blob_tx_id && (
                <div className="col-span-2">
                  <div className="text-muted-foreground mb-0.5">Blob credit tx</div>
                  <div className="num text-foreground truncate">{active.blob_tx_id}</div>
                </div>
              )}
              {active.error && (
                <div className="col-span-2 text-destructive">{active.error}</div>
              )}
            </div>
            {(active.status === "credited" || active.status === "failed") && (
              <button
                onClick={reset}
                className="text-[11px] px-3 py-1.5 rounded-full border border-border hover:border-primary/40 hover:text-primary transition"
              >
                Redeem more
              </button>
            )}
          </div>
        )}
      </div>

      <div className="lg:col-span-1 space-y-2">
        <div className="label-eyebrow px-1">Redemption history</div>
        {history.length === 0 ? (
          <div className="glass px-5 py-10 text-center text-sm text-muted-foreground">
            {validBlob ? "No redemptions yet" : "Enter a destination address"}
          </div>
        ) : (
          <div className="space-y-1.5">
            {history.map((h) => (
              <div key={h.sol_signature} className="glass px-4 py-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="num text-sm font-medium">{Number(h.amount).toFixed(BLOB_DECIMALS)} WBLOB</span>
                  <StatusPill status={h.status} />
                </div>
                {h.credit_amount != null && (
                  <div className="num text-[10px] text-muted-foreground">
                    → {Number(h.credit_amount).toFixed(BLOB_DECIMALS)} BLOB
                  </div>
                )}
                <a
                  href={`https://solscan.io/tx/${h.sol_signature}`}
                  target="_blank" rel="noreferrer"
                  className="num text-[10px] text-primary hover:underline inline-flex items-center gap-1 truncate"
                >
                  {h.sol_signature.slice(0, 16)}…
                  <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
