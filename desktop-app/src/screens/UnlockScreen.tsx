import { useState } from "react";
import type { WalletPublic } from "../lib/vault";

export function UnlockScreen({
  pub, onUnlock, onForget,
}: {
  pub: WalletPublic;
  onUnlock: (passphrase: string) => Promise<void>;
  onForget: () => void;
}) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setErr(""); setBusy(true);
    try {
      await onUnlock(pass);
      setPass(""); // clear from React state immediately on success
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="content">
      <div className="card">
        <h2>Unlock wallet</h2>
        <div className="mono muted small" style={{ marginBottom: 12 }}>{pub.address}</div>
        <label className="field">
          <span>Passphrase</span>
          <input
            type="password" value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") unlock(); }}
            autoFocus
          />
        </label>
        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy || !pass} onClick={unlock}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button
          className="danger"
          style={{ width: "100%", marginTop: 10 }}
          onClick={() => { if (confirm("Forget this wallet? Make sure you have your seed phrase backed up.")) onForget(); }}
        >Forget wallet</button>
      </div>
    </div>
  );
}
