import { useEffect, useState } from "react";
import type { NodeStatus } from "@web/lib/blobNodeClient";
import { BlobNodeClient } from "@web/lib/blobNodeClient";

export function NodeTab({
  nodeUrl, setNodeUrl, savedUrls, setSavedUrls,
  status, tipHeight, mempoolSize, chainSize, online,
}: {
  nodeUrl: string;
  setNodeUrl: (u: string) => void;
  savedUrls: string[];
  setSavedUrls: (u: string[]) => void;
  status: NodeStatus;
  tipHeight: number;
  mempoolSize: number;
  chainSize: number;
  online: boolean;
}) {
  const [draft, setDraft] = useState(nodeUrl);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"" | "ok" | "fail">("");

  useEffect(() => { setDraft(nodeUrl); setTestResult(""); }, [nodeUrl]);

  const cleanDraft = draft.trim().replace(/\/$/, "");
  const validDraft = /^https?:\/\//.test(cleanDraft);

  function apply() {
    if (!validDraft) return;
    if (!savedUrls.includes(cleanDraft)) setSavedUrls([...savedUrls, cleanDraft]);
    setNodeUrl(cleanDraft);
  }

  async function test() {
    if (!validDraft) return;
    setTesting(true); setTestResult("");
    const ok = await BlobNodeClient.healthcheck(cleanDraft, 3000);
    setTestResult(ok ? "ok" : "fail");
    setTesting(false);
  }

  return (
    <>
      <div className="card">
        <h2>Connection</h2>
        {!online && (
          <div className="warn-box" style={{ marginBottom: 10 }}>
            You appear to be offline. Reconnection will resume automatically.
          </div>
        )}
        <div className="row between" style={{ marginBottom: 10 }}>
          <span className="muted small">Status</span>
          <span className={`badge ${status === "open" ? "ok" : status === "syncing" || status === "connecting" ? "warn" : "err"}`}>{status}</span>
        </div>
        <div className="row between"><span className="muted small">Tip height</span><span className="mono">{tipHeight}</span></div>
        <div className="row between"><span className="muted small">Blocks loaded</span><span className="mono">{chainSize}</span></div>
        <div className="row between"><span className="muted small">Mempool</span><span className="mono">{mempoolSize}</span></div>
      </div>

      <div className="card">
        <h2>Node URL</h2>
        <label className="field">
          <span>Full node base URL (REST + /ws)</span>
          <input value={draft} onChange={(e) => { setDraft(e.target.value); setTestResult(""); }} placeholder="http://localhost:9090" />
        </label>
        <div className="row">
          <button className="secondary" style={{ flex: 1 }} onClick={test} disabled={!validDraft || testing}>
            {testing ? "Testing…" : "Test"}
          </button>
          <button className="primary" style={{ flex: 2 }} onClick={apply} disabled={!validDraft}>Connect</button>
        </div>
        {testResult === "ok" && <div className="ok">✓ Node reachable</div>}
        {testResult === "fail" && <div className="err">Couldn't reach node at {cleanDraft}</div>}
      </div>

      <div className="card">
        <h2>Saved nodes</h2>
        {savedUrls.length === 0 && <div className="muted small">None saved.</div>}
        {savedUrls.map((u) => (
          <div key={u} className="row between" style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
            <span className="mono small" style={{ color: u === nodeUrl ? "var(--primary)" : "var(--text)" }}>{u}</span>
            <div className="row">
              <button className="secondary" onClick={() => setNodeUrl(u)}>Use</button>
              <button className="danger" onClick={() => setSavedUrls(savedUrls.filter(x => x !== u))}>×</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
