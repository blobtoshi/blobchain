import { useEffect, useState } from "react";
import {
  generateWallet, mnemonicToPrivateKey, isValidMnemonic, pubKeyToAddress,
  hexToBytes, bytesToHex,
} from "@web/lib/blob/crypto";
import * as secp from "@noble/secp256k1";
import { saveEncryptedWallet, type WalletPlain, type WalletPublic } from "../lib/vault";
import { wipeWallet } from "../lib/secret";

export function SetupScreen({ onCreated }: { onCreated: (p: WalletPublic) => void }) {
  const [mode, setMode] = useState<"create" | "import">("create");
  const [generated, setGenerated] = useState<WalletPlain | null>(null);
  const [importPhrase, setImportPhrase] = useState("");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function gen() {
    const w = await generateWallet();
    setGenerated((prev) => { if (prev) wipeWallet(prev); return w; });
  }
  useEffect(() => { if (mode === "create" && !generated) gen(); }, [mode]);

  // Wipe the in-memory generated wallet when leaving setup.
  useEffect(() => () => { if (generated) wipeWallet(generated); }, []);

  async function save() {
    setErr("");
    if (pass1.length < 6) { setErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setErr("Passphrases don't match"); return; }
    setBusy(true);
    let w: WalletPlain | null = null;
    try {
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
      const pub = { address: w.address, publicKey: w.publicKey };
      // Wipe everything sensitive before we hand control back.
      setImportPhrase("");
      setPass1(""); setPass2("");
      if (mode === "import" && w) wipeWallet(w);
      onCreated(pub);
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
