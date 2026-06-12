// submit-tx: relay a pre-signed BLOB transaction to the node network.
// Tries each node in BLOB_NODE_URL (comma-separated) until one succeeds.
//
// GET  /submit-tx          → returns current fee-info from the fastest node
// POST /submit-tx { ...tx } → broadcasts tx to node, returns { ok, id } or { error }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const NODE_URLS = (Deno.env.get("BLOB_NODE_URL") ?? "https://node.blobchain.network")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

function toWs(url: string) {
  return url.replace(/^https?/, (p) => p === "https" ? "wss" : "ws") + "/ws";
}

function ok_(obj: unknown) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function bad(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function submitTxWs(nodeUrl: string, tx: unknown): Promise<{ ok: boolean; id?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: { ok: boolean; id?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(result);
    };

    const timeout = setTimeout(() => done({ ok: false, error: "node timeout" }), 10_000);

    let ws: WebSocket;
    try {
      ws = new WebSocket(toWs(nodeUrl));
    } catch (e) {
      clearTimeout(timeout);
      resolve({ ok: false, error: `ws connect failed: ${String(e)}` });
      return;
    }

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe" }));
      ws.send(JSON.stringify({ type: "submitTx", tx }));
    };

    ws.onmessage = (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "ack" && msg.ref === "submitTx") {
        clearTimeout(timeout);
        done({ ok: true, id: msg.data?.id });
      }
      if (msg.type === "error" && msg.ref === "submitTx") {
        clearTimeout(timeout);
        done({ ok: false, error: msg.message ?? "node rejected tx" });
      }
    };

    ws.onerror = () => { clearTimeout(timeout); done({ ok: false, error: "ws error" }); };
    ws.onclose = () => { clearTimeout(timeout); if (!settled) done({ ok: false, error: "ws closed before ack" }); };
  });
}

async function submitWithFailover(tx: unknown): Promise<{ ok: boolean; id?: string; error?: string }> {
  const errors: string[] = [];
  for (const url of NODE_URLS) {
    const result = await submitTxWs(url, tx);
    if (result.ok) return result;
    errors.push(`${url}: ${result.error}`);
    console.warn(`[submit-tx] node failed, trying next`, { url, error: result.error });
  }
  return { ok: false, error: `all nodes failed: ${errors.join(" | ")}` };
}

async function fetchFeeInfo(): Promise<Response> {
  for (const url of NODE_URLS) {
    try {
      const r = await fetch(`${url}/fee-info`);
      if (r.ok) {
        const j = await r.json();
        return ok_(j);
      }
    } catch { /* try next */ }
  }
  return bad("all nodes unreachable", 502);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method === "GET") return fetchFeeInfo();
  if (req.method !== "POST") return bad("method not allowed", 405);

  let tx: unknown;
  try { tx = await req.json(); }
  catch { return bad("invalid json"); }

  if (!tx || typeof tx !== "object") return bad("invalid tx");

  const result = await submitWithFailover(tx);
  if (!result.ok) return bad(result.error ?? "broadcast failed", 502);
  return ok_({ ok: true, id: result.id });
});