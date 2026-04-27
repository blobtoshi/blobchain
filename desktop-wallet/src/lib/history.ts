import type { Block, Tx } from "@web/lib/wsProtocol";
import { TX_FEE } from "@web/lib/blob/constants";

export type HistoryEntry =
  | {
      kind: "send";
      id: string;
      counterparty: string;
      amount: number; // positive — what left the wallet (excluding fee)
      fee: number;
      memo?: string;
      timestamp: number;
      blockHeight: number | null; // null = pending in mempool
    }
  | {
      kind: "receive";
      id: string;
      counterparty: string;
      amount: number;
      memo?: string;
      timestamp: number;
      blockHeight: number | null;
    }
  | {
      kind: "reward";
      id: string; // synthetic: `reward:<height>`
      amount: number;
      timestamp: number;
      blockHeight: number;
    };

// Build chronological tx history for an address from the chain + mempool.
// Confirmed txs come from blocks; pending txs come from the mempool.
// Mining rewards (when this address is the block winner) get their own entry.
export function buildHistory(
  address: string,
  chain: Block[],
  mempool: Tx[],
): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  const seenTxIds = new Set<string>();

  for (const block of chain) {
    if (block.winner === address && (block.reward || 0) > 0) {
      out.push({
        kind: "reward",
        id: `reward:${block.height}`,
        amount: block.reward,
        timestamp: block.timestamp,
        blockHeight: block.height,
      });
    }
    for (const tx of block.transactions || []) {
      if (tx.from !== address && tx.to !== address) continue;
      seenTxIds.add(tx.id);
      if (tx.from === address) {
        out.push({
          kind: "send",
          id: tx.id,
          counterparty: tx.to,
          amount: tx.amount,
          fee: tx.fee ?? TX_FEE,
          memo: tx.memo,
          timestamp: tx.timestamp,
          blockHeight: block.height,
        });
      } else {
        out.push({
          kind: "receive",
          id: tx.id,
          counterparty: tx.from,
          amount: tx.amount,
          memo: tx.memo,
          timestamp: tx.timestamp,
          blockHeight: block.height,
        });
      }
    }
  }

  for (const tx of mempool) {
    if (seenTxIds.has(tx.id)) continue;
    if (tx.from !== address && tx.to !== address) continue;
    if (tx.from === address) {
      out.push({
        kind: "send",
        id: tx.id,
        counterparty: tx.to,
        amount: tx.amount,
        fee: tx.fee ?? TX_FEE,
        memo: tx.memo,
        timestamp: tx.timestamp,
        blockHeight: null,
      });
    } else {
      out.push({
        kind: "receive",
        id: tx.id,
        counterparty: tx.from,
        amount: tx.amount,
        memo: tx.memo,
        timestamp: tx.timestamp,
        blockHeight: null,
      });
    }
  }

  // Newest first; pending sort to top within same timestamp.
  out.sort((a, z) => {
    if (z.timestamp !== a.timestamp) return z.timestamp - a.timestamp;
    const ah = a.blockHeight ?? Number.MAX_SAFE_INTEGER;
    const zh = z.blockHeight ?? Number.MAX_SAFE_INTEGER;
    return zh - ah;
  });
  return out;
}
