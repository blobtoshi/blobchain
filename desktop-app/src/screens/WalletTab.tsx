import { useEffect, useState } from "react";
import { BLOB_DECIMALS } from "@web/lib/blob/constants";
import type { WalletPlain } from "../lib/vault";

export function WalletTab({
  wallet, balance, onLock,
}: { wallet: WalletPlain; balance: number; onLock: () => void }) {
  const [showSeed, setShowSeed] = useState(false);
  const [showPriv, setShowPriv] = useState(false);
  const [copied, setCopied] = useState(false);

  // Auto-hide secrets after 30s — defense against shoulder-surfing if user
  // walks away from the screen without locking.
  useEffect(() => {
    if (!showSeed && !showPriv) return;
    const t = window.setTimeout(() => { setShowSeed(false); setShowPriv(false); }, 30_000);
    return () => window.clearTimeout(t);
  }, [showSeed, showPriv]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }

  return (
    <>
      <div className="card">
        <h2>Balance</h2>
        <div className="balance">{balance.toFixed(BLOB_DECIMALS)}<span className="unit">BLOB</span></div>
      </div>

      <div className="card">
        <h2>Address</h2>
        <div className="mono">{wallet.address}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="secondary" onClick={copy}>
            {copied ? "✓ Copied" : "Copy address"}
          </button>
          <button className="secondary" onClick={onLock}>Lock</button>
        </div>
      </div>

      <div className="card">
        <h2>Backup</h2>
        {wallet.mnemonic ? (
          <>
            <button className="secondary" onClick={() => setShowSeed(s => !s)}>
              {showSeed ? "Hide" : "Reveal"} 12-word seed
            </button>
            {showSeed && (
              <>
                <div className="seed-grid" style={{ marginTop: 10 }}>
                  {wallet.mnemonic.split(" ").map((w, i) => (
                    <div key={i}><span className="num">{i + 1}.</span>{w}</div>
                  ))}
                </div>
                <div className="muted small" style={{ marginTop: 6 }}>Auto-hides in 30s.</div>
              </>
            )}
          </>
        ) : (
          <div className="muted small">No seed phrase stored (imported as raw key).</div>
        )}
        <button className="secondary" style={{ marginTop: 8 }} onClick={() => setShowPriv(s => !s)}>
          {showPriv ? "Hide" : "Reveal"} private key
        </button>
        {showPriv && <div className="mono small" style={{ marginTop: 8 }}>{wallet.privateKey}</div>}
      </div>
    </>
  );
}
