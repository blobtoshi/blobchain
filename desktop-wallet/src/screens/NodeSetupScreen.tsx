import { useState } from "react";
import { BlobNodeClient } from "@web/lib/blobNodeClient";
import { DEFAULT_NODE } from "../hooks/useNodeConfig";

// Mandatory first-run screen: nothing else loads until the user picks a node.
// They can change it anytime later from the Node tab.
export function NodeSetupScreen({
  onChosen,
}: {
  onChosen: (url: string) => void;
}) {
  const [draft, setDraft] = useState(DEFAULT_NODE);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<"" | "ok" | "fail">("");

  const cleanDraft = draft.trim().replace(/\/$/, "");
  const validDraft = /^https?:\/\//.test(cleanDraft);

  async function test() {
    if (!validDraft) return;
    setTesting(true); setResult("");
    const ok = await BlobNodeClient.healthcheck(cleanDraft, 3000);
    setResult(ok ? "ok" : "fail");
    setTesting(false);
  }

  function connect() {
    if (!validDraft) return;
    onChosen(cleanDraft);
  }

  return (
    <div className="content">
      <div className="card">
        <h2>Choose a node</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          BLOB Wallet talks directly to a full node. Pick one to connect to before
          setting up your wallet. You can change this later from the Node tab.
        </p>

        <label className="field" style={{ marginTop: 12 }}>
          <span>Full node base URL (REST + /ws)</span>
          <input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setResult(""); }}
            placeholder="http://localhost:9090"
          />
        </label>

        <div className="row">
          <button
            className="secondary"
            style={{ flex: 1 }}
            onClick={test}
            disabled={!validDraft || testing}
          >
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button
            className="primary"
            style={{ flex: 2 }}
            onClick={connect}
            disabled={!validDraft}
          >
            Continue
          </button>
        </div>

        {result === "ok" && <div className="ok">✓ Node reachable</div>}
        {result === "fail" && (
          <div className="err">
            Couldn't reach node at {cleanDraft}. You can still continue — the wallet
            will keep retrying in the background.
          </div>
        )}
      </div>
    </div>
  );
}
