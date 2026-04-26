import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateWallet, mnemonicToPrivateKey, isValidMnemonic, pubKeyToAddress,
  hexToBytes, bytesToHex, sha256hex, signData,
} from "@web/lib/blob/crypto";
import * as secp from "@noble/secp256k1";
import { calcBalance } from "@web/lib/blob/chain";
import { canonicalTxBytes, estimateTxBytes, feeFromRate, memoBytes, to8 } from "@web/lib/blob/fees";
import { ADDR_RE, BASE_FEE_RATE, MIN_FEE_RATE, MAX_MEMO_BYTES, BLOB_DECIMALS } from "@web/lib/blob/constants";
import { BlobNodeClient, type NodeStatus } from "@web/lib/blobNodeClient";
import {
  saveEncryptedWallet, getStoredWalletPublic, unlockWallet, clearWallet,
  type WalletPlain, type WalletPublic,
} from "./lib/vault";

const DEFAULT_NODE = "http://localhost:9090";

type Tab = "wallet" | "send" | "node";

export default function App() {
  // ── Wallet state ────────────────────────────────────────────────────
  const [pub, setPub] = useState<WalletPublic | null>(null);
  const [plain, setPlain] = useState<WalletPlain | null>(null);
  const [loadingVault, setLoadingVault] = useState(true);

  // ── Node + chain state ──────────────────────────────────────────────
  const [nodeUrl, setNodeUrl] = useState<string>(DEFAULT_NODE);
  const [savedUrls, setSavedUrls] = useState<string[]>([DEFAULT_NODE]);
  const clientRef = useRef<BlobNodeClient | null>(null);
  const [status, setStatus] = useState<NodeStatus>("idle");
  const [tipHeight, setTipHeight] = useState(0);
  const [chain, setChain] = useState<any[]>([]);
  const [mempool, setMempool] = useState<any[]>([]);

  const [tab, setTab] = useState<Tab>("wallet");

  // Boot: load vault metadata + node config
  useEffect(() => {
    (async () => {
      const p = await getStoredWalletPublic();
      setPub(p);
      setLoadingVault(false);
      try {
        const cfgRaw = await window.nodeConfigBridge!.read();
        if (cfgRaw) {
          const cfg = JSON.parse(cfgRaw);
          if (cfg.current) setNodeUrl(cfg.current);
          if (Array.isArray(cfg.saved)) setSavedUrls(cfg.saved);
        }
      } catch { /* defaults */ }
    })();
  }, []);

  // (Re)connect node client when URL changes
  useEffect(() => {
    if (!nodeUrl) return;
    clientRef.current?.close();
    const c = new BlobNodeClient(nodeUrl);
    clientRef.current = c;
    setStatus("idle");
    setChain([]);
    setMempool([]);
    setTipHeight(0);
    const blocks: any[] = [];
    c.setHandlers({
      onStatus: (s) => setStatus(s),
      onTip: (t) => setTipHeight(t.height),
      onBlock: (b) => {
        blocks.push(b);
        // Throttle React updates: copy on each block is fine for small chains.
        setChain((prev) => {
          // de-dup by height
          const map = new Map<number, any>();
          for (const x of prev) map.set(x.height, x);
          map.set(b.height, b);
          return Array.from(map.values()).sort((a, z) => a.height - z.height);
        });
      },
      onTx: (t) => setMempool((m) => (m.find(x => x.id === t.id) ? m : [...m, t])),
    });
    c.connect();
    // Refresh mempool on (re)connect
    const refreshMempool = async () => {
      const mp = await c.fetchMempool();
      setMempool(mp);
    };
    const t = setTimeout(refreshMempool, 1500);
    return () => { clearTimeout(t); c.close(); };
  }, [nodeUrl]);

  // Persist node config
  useEffect(() => {
    window.nodeConfigBridge?.write(JSON.stringify({ current: nodeUrl, saved: savedUrls }));
  }, [nodeUrl, savedUrls]);

  const balance = useMemo(() => {
    if (!pub) return 0;
    return calcBalance(pub.address, chain, mempool);
  }, [pub, chain, mempool]);

  if (loadingVault) {
    return <div className="app"><div className="content"><div className="muted">Loading…</div></div></div>;
  }

  return (
    <div className="app">
      <header className="header">
        <h1>BLOB Wallet</h1>
        <span className={`badge ${status === "open" ? "ok" : status === "syncing" || status === "connecting" ? "warn" : "err"}`}>
          {status} · h{tipHeight}
        </span>
      </header>

      {!pub ? (
        <SetupScreen onCreated={(p) => setPub(p)} />
      ) : !plain ? (
        <UnlockScreen
          pub={pub}
          onUnlocked={(w) => { setPlain(w); setTab("wallet"); }}
          onForget={async () => { await clearWallet(); setPub(null); setPlain(null); }}
        />
      ) : (
        <>
          <nav className="tabs">
            <button className={tab === "wallet" ? "active" : ""} onClick={() => setTab("wallet")}>Wallet</button>
            <button className={tab === "send" ? "active" : ""} onClick={() => setTab("send")}>Send</button>
            <button className={tab === "node" ? "active" : ""} onClick={() => setTab("node")}>Node</button>
          </nav>
          <div className="content">
            {tab === "wallet" && (
              <WalletTab
                wallet={plain}
                balance={balance}
                onLock={() => setPlain(null)}
              />
            )}
            {tab === "send" && (
              <SendTab
                wallet={plain}
                balance={balance}
                client={clientRef.current}
                status={status}
              />
            )}
            {tab === "node" && (
              <NodeTab
                nodeUrl={nodeUrl}
                setNodeUrl={setNodeUrl}
                savedUrls={savedUrls}
                setSavedUrls={setSavedUrls}
                status={status}
                tipHeight={tipHeight}
                mempoolSize={mempool.length}
                chainSize={chain.length}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Setup: create / import
// ─────────────────────────────────────────────────────────────────────────
function SetupScreen({ onCreated }: { onCreated: (p: WalletPublic) => void }) {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [generated, setGenerated] = useState<WalletPlain | null>(null);
  const [importPhrase, setImportPhrase] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function gen() {
    const w = await generateWallet();
    setGenerated(w);
  }
  useEffect(() => { if (mode === "create" && !generated) gen(); }, [mode]);

  async function save() {
    setErr("");
    if (pass1.length < 6) { setErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setErr("Passphrases don't match"); return; }
    setBusy(true);
    try {
      let w: WalletPlain;
      if (mode === "create") {
        if (!generated) throw new Error("No wallet generated");
        w = generated;
      } else {
        const phrase = importPhrase.trim().toLowerCase();
        if (!isValidMnemonic(phrase)) throw new Error("Invalid 12-word seed phrase");
        const priv = mnemonicToPrivateKey(phrase);
        const pubBytes = secp.getPublicKey(hexToBytes(priv), true);
        const publicKey = bytesToHex(pubBytes);
        const address = pubKeyToAddress(publicKey);
        w = { address, publicKey, privateKey: priv, mnemonic: phrase };
      }
      await saveEncryptedWallet(w, pass1);
      onCreated({ address: w.address, publicKey: w.publicKey });
    } catch (e: any) {
      setErr(e?.message || String(e));
    } finally { setBusy(false); }
  }

  const seedWords = generated?.mnemonic?.split(" ") ?? [];

  return (
    <div className="content">
      <div className="card">
        <h2>Setup</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <button
            className="secondary"
            style={{ flex: 1, borderColor: mode === "create" ? "var(--primary)" : "var(--border)" }}
            onClick={() => setMode("create")}
          >Create new</button>
          <button
            className="secondary"
            style={{ flex: 1, borderColor: mode === "import" ? "var(--primary)" : "var(--border)" }}
            onClick={() => setMode("import")}
          >Import seed</button>
        </div>

        {mode === "create" && generated && (
          <>
            <div className="warn-box">
              Write down these 12 words and keep them safe. Anyone with this phrase controls your funds.
            </div>
            <div className="seed-grid">
              {seedWords.map((w, i) => (
                <div key={i}><span className="num">{i + 1}.</span>{w}</div>
              ))}
            </div>
            <button className="secondary" style={{ marginTop: 8 }} onClick={gen}>Regenerate</button>
          </>
        )}

        {mode === "import" && (
          <label className="field">
            <span>12-word seed phrase</span>
            <textarea
              value={importPhrase}
              onChange={(e) => setImportPhrase(e.target.value)}
              placeholder="word1 word2 word3 …"
            />
          </label>
        )}

        <label className="field" style={{ marginTop: 12 }}>
          <span>Passphrase (encrypts vault on this computer)</span>
          <input type="password" value={pass1} onChange={(e) => setPass1(e.target.value)} />
        </label>
        <label className="field">
          <span>Confirm passphrase</span>
          <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
        </label>

        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy} onClick={save}>
          {busy ? "Saving…" : mode === "create" ? "Save wallet" : "Import wallet"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Unlock
// ─────────────────────────────────────────────────────────────────────────
function UnlockScreen({
  pub, onUnlocked, onForget,
}: {
  pub: WalletPublic;
  onUnlocked: (w: WalletPlain) => void;
  onForget: () => void;
}) {
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setErr(""); setBusy(true);
    try {
      const w = await unlockWallet(pass);
      onUnlocked(w);
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

// ─────────────────────────────────────────────────────────────────────────
// Wallet tab
// ─────────────────────────────────────────────────────────────────────────
function WalletTab({
  wallet, balance, onLock,
}: { wallet: WalletPlain; balance: number; onLock: () => void }) {
  const [showSeed, setShowSeed] = useState(false);
  const [showPriv, setShowPriv] = useState(false);

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
          <button className="secondary" onClick={() => navigator.clipboard.writeText(wallet.address)}>
            Copy address
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
              <div className="seed-grid" style={{ marginTop: 10 }}>
                {wallet.mnemonic.split(" ").map((w, i) => (
                  <div key={i}><span className="num">{i + 1}.</span>{w}</div>
                ))}
              </div>
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

// ─────────────────────────────────────────────────────────────────────────
// Send tab
// ─────────────────────────────────────────────────────────────────────────
function SendTab({
  wallet, balance, client, status,
}: {
  wallet: WalletPlain; balance: number;
  client: BlobNodeClient | null; status: NodeStatus;
}) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [memo, setMemo] = useState("");
  const [feeInfo, setFeeInfo] = useState<{ recommendedFeeRate: number; minFeeRate: number; baseFeeRate: number } | null>(null);
  const [preset, setPreset] = useState<"slow" | "normal" | "fast" | "custom">("normal");
  const [customRate, setCustomRate] = useState("");
  const [st, setSt] = useState<"idle" | "signing" | "broadcasting" | "sent">("idle");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!client) return;
    let alive = true;
    const load = async () => {
      const i = await client.fetchFeeInfo();
      if (alive && i) setFeeInfo(i);
    };
    load();
    const id = setInterval(load, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, [client, status]);

  const recRate = feeInfo?.recommendedFeeRate ?? BASE_FEE_RATE;
  const presets = {
    slow: Math.max(MIN_FEE_RATE, Math.floor(recRate * 0.5)),
    normal: Math.max(MIN_FEE_RATE, recRate),
    fast: Math.max(MIN_FEE_RATE, Math.ceil(recRate * 2)),
  };
  const activeRate = preset === "custom"
    ? Math.max(MIN_FEE_RATE, Math.floor(Number(customRate) || 0))
    : presets[preset];

  const trimmed = to.trim();
  const validTo = ADDR_RE.test(trimmed) ? trimmed : "";
  const parsedAmt = (() => { const n = parseFloat(amt); return Number.isFinite(n) && n > 0 ? to8(n) : 0; })();
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
      setTimeout(() => setSt("idle"), 1800);
    } catch (e: any) {
      setErr(e?.message || String(e));
      setSt("idle");
    }
  }

  return (
    <>
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
        {status !== "open" && <div className="muted small" style={{ marginTop: 8, textAlign: "center" }}>Node status: {status}</div>}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Node tab
// ─────────────────────────────────────────────────────────────────────────
function NodeTab({
  nodeUrl, setNodeUrl, savedUrls, setSavedUrls,
  status, tipHeight, mempoolSize, chainSize,
}: {
  nodeUrl: string;
  setNodeUrl: (u: string) => void;
  savedUrls: string[];
  setSavedUrls: (u: string[]) => void;
  status: NodeStatus;
  tipHeight: number;
  mempoolSize: number;
  chainSize: number;
}) {
  const [draft, setDraft] = useState(nodeUrl);
  useEffect(() => { setDraft(nodeUrl); }, [nodeUrl]);

  function apply() {
    const clean = draft.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(clean)) return;
    if (!savedUrls.includes(clean)) setSavedUrls([...savedUrls, clean]);
    setNodeUrl(clean);
  }

  return (
    <>
      <div className="card">
        <h2>Connection</h2>
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
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="http://localhost:9090" />
        </label>
        <button className="primary" onClick={apply} disabled={!/^https?:\/\//.test(draft.trim())}>Connect</button>
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
