import { useMemo } from "react";
import type { Block, Tx } from "@web/lib/wsProtocol";
import { BLOB_DECIMALS } from "@web/lib/blob/constants";
import { buildHistory, type HistoryEntry } from "../lib/history";

export function HistoryTab({
  address,
  chain,
  mempool,
}: {
  address: string;
  chain: Block[];
  mempool: Tx[];
}) {
  const history = useMemo(
    () => buildHistory(address, chain, mempool),
    [address, chain, mempool],
  );

  return (
    <div className="card">
      <h2>Transaction history</h2>
      {history.length === 0 ? (
        <div className="muted small">No transactions yet.</div>
      ) : (
        <div className="history-list">
          {history.map((h) => <HistoryRow key={h.id} entry={h} />)}
        </div>
      )}
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const pending = entry.kind !== "reward" && entry.blockHeight === null;
  const sign = entry.kind === "send" ? "−" : "+";
  const total =
    entry.kind === "send"
      ? entry.amount + entry.fee
      : entry.amount;
  const label =
    entry.kind === "send" ? "Sent"
      : entry.kind === "receive" ? "Received"
      : "Mining reward";

  return (
    <div className="history-row">
      <div className="history-main">
        <div className="row between">
          <span className={`badge ${entry.kind === "send" ? "warn" : "ok"}`}>
            {label}{pending ? " · pending" : ""}
          </span>
          <span className={`mono ${entry.kind === "send" ? "amount-out" : "amount-in"}`}>
            {sign}{total.toFixed(BLOB_DECIMALS)} BLOB
          </span>
        </div>
        {"counterparty" in entry && (
          <div className="mono small muted" style={{ marginTop: 4, wordBreak: "break-all" }}>
            {entry.kind === "send" ? "To " : "From "}{entry.counterparty}
          </div>
        )}
        <div className="row between" style={{ marginTop: 4 }}>
          <span className="muted small">
            {new Date(entry.timestamp).toLocaleString()}
          </span>
          <span className="muted small">
            {entry.blockHeight !== null ? `block #${entry.blockHeight}` : "in mempool"}
          </span>
        </div>
        {entry.kind !== "reward" && entry.memo && (
          <div className="small" style={{ marginTop: 4, fontStyle: "italic" }}>
            "{entry.memo}"
          </div>
        )}
        {entry.kind === "send" && (
          <div className="muted small" style={{ marginTop: 2 }}>
            Fee {entry.fee.toFixed(BLOB_DECIMALS)}
          </div>
        )}
      </div>
    </div>
  );
}
