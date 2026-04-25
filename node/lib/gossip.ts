// WebSocket gossip helpers. Tracks subscribed clients and broadcasts new
// blocks / txs / entries to all of them. Designed to be cheap: keeps a Set
// of live sockets and prunes them on close.

import type { WebSocket } from "ws";
import type { ServerMsg } from "../wsProtocol.js";

export class Gossip {
  private subs = new Set<WebSocket>();

  subscribe(ws: WebSocket) {
    this.subs.add(ws);
    ws.once("close", () => this.subs.delete(ws));
  }

  unsubscribe(ws: WebSocket) {
    this.subs.delete(ws);
  }

  count(): number {
    return this.subs.size;
  }

  broadcast(msg: ServerMsg) {
    const json = JSON.stringify(msg);
    for (const ws of this.subs) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(json); } catch { /* drop */ }
      }
    }
  }
}

export function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch { /* drop */ }
  }
}
