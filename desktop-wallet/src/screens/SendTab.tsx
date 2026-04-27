import { useEffect, useMemo, useState } from "react";
import { sha256hex, signData } from "@web/lib/blob/crypto";
import { canonicalTxBytes, estimateTxBytes, feeFromRate, memoBytes, to8 } from "@web/lib/blob/fees";
import { ADDR_RE, BASE_FEE_RATE, MIN_FEE_RATE, MAX_MEMO_BYTES, BLOB_DECIMALS } from "@web/lib/blob/constants";
import type { BlobNodeClient, NodeStatus } from "@web/lib/blobNodeClient";
import type { WalletPlain } from "../lib/vault";

type Preset = "slow" | "normal" | "fast" | "custom";
type SendState = "idle" | "signing" | "broadcasting" | "sent";

export function SendTab({
  wallet, balance, client, status,
}: {
  wallet: WalletPlain; balance: number;
  client: BlobNodeClient | null; status: NodeStatus;
}) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [memo, setMemo] = useState("");
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [preset, setPreset] = useState<Preset>("normal");
  const [customRate, setCustomRate] = useState("");
  const [st, setSt] = useState<SendState>("idle");
  const [err, setErr] = useState("");

  // Pull fee-info on connect, refresh every 20s while open.
  useEffect(() => {
    if (!client || status !== "open") return;
    let alive = true;
    const load = async () => {
      const i = await client.fetchFeeInfo();
      if (alive && i) setFeeInfo(i);
    };
    load();
    const id = window.setInterval(load, 20_000);
    return () => { alive = false; window.clearInterval(id); };
  }, [client, status]);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;

  const { activeRate, presets } = useMemo(() => {
    const presets = {
      slow: Math.max(MIN_FEE_RATE, Math.floor(recRate * 0.5)),
      normal: Math.max(MIN_FEE_RATE, recRate),
      fast: Math.max(MIN_FEE_RATE, Math.ceil(recRate * 2)),
    };
    const activeRate = preset === "custom"
      ? Math.max(MIN_FEE_RATE, Math.floor(Number(customRate) || 0))
      : presets[preset];
    return { activeRate, presets };
  }, [recRate, preset, customRate]);

  const trimmed = to.trim();
  const validTo = ADDR_RE.test(trimmed) ? trimmed : "";
  const parsedAmt = useMemo(() => {
    const n = parseFloat(amt);
    return Number.isFinite(n) && n > 0 ? to8(n) : 0;
  }, [amt]);
  const memoLen = memoBytes(memo);
  const memoOver = memoLen > MAX_MEMO_BYTES;

  const previewBytes = validTo && parsedAmt > 0 && activeRate >= MIN_FEE_RATE && !memoOver
    ? estimateTxBytes(wallet.address, validTo, parsedAmt, Date.now(), activeRate, memo)
    : 0;
  const previewFee = previewBytes ? feeFromRate(activeRate, previewBytes) : 0;
  const previewTotal = parsedAmt + previewFee;

  async function send() {
    setErr("");
    if (!client || status !== "open") { setErr("Not connected to a node"); return; }
    if (!validTo) { setErr("Invalid recipient address"); return; }
    if (validTo === wallet.address) { setErr("Cannot send to yourself"); return; }
    if (parsedAmt <= 0) { setErr("Invalid amount"); return; }
    if (memoOver) { setErr(`Memo too long (${memoLen}/${MAX_MEMO_BYTES} bytes)`); return; }
    setSt("signing");
    try {
      const ts = Date.now();
      const txid = await sha256hex(`${wallet.address}${validTo}${parsedAmt}${ts}${activeRate}${memo}`);
      const data = `${wallet.address}→${validTo}:${parsedAmt}@${ts}|fr=${activeRate}|m=${memo}`;
      const sig = await signData(wallet.privateKey, data);
      const bytes = canonicalTxBytes({
        from: wallet.address, to: validTo, amount: parsedAmt, timestamp: ts,
        feeRate: activeRate, memo, publicKey: wallet.publicKey, signature: sig,
      });
      const fee = feeFromRate(activeRate, bytes);
      if (parsedAmt + fee > balance) {
        setErr(`Insufficient balance (need ${(parsedAmt + fee).toFixed(BLOB_DECIMALS)})`);
        setSt("idle"); return;
      }
      setSt("broadcasting");
      await client.submitTx({
        id: txid.slice(0, 40),
        from: wallet.address,
        to: validTo,
        amount: parsedAmt,
        feeRate: activeRate,
        memo,
        signature: sig,
        publicKey: wallet.publicKey,
        timestamp: ts,
      });
      setSt("sent");
      setTo(""); setAmt(""); setMemo("");
      window.setTimeout(() => setSt("idle"), 1800);
    } catch (e: any) {
      setErr(friendlyError(e));
      setSt("idle");
    }
  }

  return (
    <div className="card">
      <h2>Send</h2>
      <div className="row between small muted" style={{ marginBottom: 10 }}>
        <span>Available</span>
        <span className="mono" style={{ color: "var(--primary)" }}>{balance.toFixed(BLOB_DECIMALS)} BLOB</span>
      </div>

      <label className="field">
        <span>Recipient</span>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Recipient address (1…)" />
      </label>
      <label className="field">
        <span>Amount (BLOB)</span>
        <input type="number" min="0" step="0.00000001" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="0.00000000" />
      </label>
      <label className="field">
        <span>Memo (optional, max {MAX_MEMO_BYTES}B)</span>
        <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Note" />
      </label>

      <div className="field">
        <span style={{ display: "block", fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
          Fee preset (recommended {recRate} drops/B)
        </span>
        <div className="preset-row">
          {(["slow", "normal", "fast", "custom"] as const).map(p => (
            <button key={p} className={preset === p ? "active" : ""} onClick={() => setPreset(p)}>
              {p}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <input
            type="number" min={MIN_FEE_RATE} step="1"
            value={customRate} onChange={(e) => setCustomRate(e.target.value)}
            placeholder={String(recRate)} style={{ marginTop: 8 }}
          />
        )}
      </div>

      <div className="summary">
        <div className="line"><span className="muted">Fee rate</span><span className="mono">{activeRate} drops/B</span></div>
        <div className="line"><span className="muted">Tx size (est.)</span><span className="mono">{previewBytes || "—"} B</span></div>
        <div className="line"><span className="muted">Network fee</span><span className="mono">{previewFee.toFixed(BLOB_DECIMALS)}</span></div>
        <div className="line total"><span>Total</span><span className="mono">{previewTotal.toFixed(BLOB_DECIMALS)} BLOB</span></div>
      </div>

      {err && <div className="err">{err}</div>}
      {st === "sent" && <div className="ok">✓ Broadcast to mempool</div>}

      <button
        className="primary"
        style={{ marginTop: 12 }}
        disabled={st !== "idle" || memoOver || status !== "open"}
        onClick={send}
      >
        {st === "idle" ? "Broadcast transaction"
          : st === "signing" ? "Signing…"
          : st === "broadcasting" ? "Broadcasting…"
          : "✓ Sent"}
      </button>
      {status !== "open" && (
        <div className="muted small" style={{ marginTop: 8, textAlign: "center" }}>
          {status === "connecting" ? "Connecting to node…"
            : status === "syncing" ? "Syncing chain…"
            : status === "closed" ? "Disconnected — will reconnect automatically."
            : status === "error" ? "Connection error — check the node URL."
            : `Node status: ${status}`}
        </div>
      )}
    </div>
  );
}

// Map common low-level errors to something a non-developer can act on.
function friendlyError(e: any): string {
  const msg = e?.message || String(e);
  if (/socket not open|socket closed/i.test(msg)) return "Lost connection to the node. Try again in a moment.";
  if (/ack timeout/i.test(msg)) return "The node did not respond. It may be overloaded.";
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Network error. Check your internet connection.";
  return msg;
}
