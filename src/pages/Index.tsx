// @ts-nocheck
// ═══════════════════════════════════════════════════════════════════════════════
// BLOB CHAIN — Proof-of-Gaming Blockchain
// Thin orchestrator. State lives in hooks (useBlockchain, useWalletVault),
// UI lives in src/components/blob/*, pure logic lives in src/lib/blob/*.
// ═══════════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Send, Wallet, Plus, Download, Lock, Settings as SettingsIcon, LogOut, ChevronDown, Eye, EyeOff, ArrowLeftRight, Copy, Check, ShieldAlert, KeyRound, FileKey } from "lucide-react";
import blobLogo from "@/assets/blob-logo.png";

import { useBlockchain } from "@/hooks/useBlockchain";
import { useWalletVault } from "@/hooks/useWalletVault";
import { calcBalance } from "@/lib/blob/chain";

import BlobRunGame from "@/components/blob/BlobRunGame";
import MineHero from "@/components/blob/MineHero";
import MiningPanel from "@/components/blob/MiningPanel";
import SendTxForm from "@/components/blob/SendTxForm";
import WalletScreen from "@/components/blob/WalletScreen";
import BridgeScreen from "@/components/blob/BridgeScreen";
import BlockExplorer from "@/components/blob/BlockExplorer";
import NetworkView from "@/components/blob/NetworkView";

export default function BlobChainApp() {
  // ── Wallet (vault + lifecycle) ────────────────────────────────────────────
  const {
    wallet, vaultPub, walletRef,
    createWallet, importWallet, unlockExisting, disconnectWallet,
  } = useWalletVault();

  // ── Chain / mempool / entries (relay-backed) ──────────────────────────────
  const {
    chain, mempool, entries, myEntry, blockInfo, newBlock,
    onEntrySubmit, onTxBroadcast,
  } = useBlockchain(walletRef);

  // ── Local UI state ────────────────────────────────────────────────────────
  const [screen, setScreen] = useState("mine");
  const [gameLaunched, setGameLaunched] = useState(false);
  const [nodeCount] = useState(1);

  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPass, setUnlockPass] = useState("");
  const [unlockErr, setUnlockErr] = useState("");
  const [unlocking, setUnlocking] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showPriv, setShowPriv] = useState(false);
  const [privCopied, setPrivCopied] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [seedSettingsCopied, setSeedSettingsCopied] = useState(false);

  // Auto-hide sensitive material (private key + seed) after 30s or on tab blur.
  useEffect(() => {
    if (!showPriv && !showSeed) return;
    const t = window.setTimeout(() => { setShowPriv(false); setShowSeed(false); }, 30_000);
    const onVis = () => { if (document.hidden) { setShowPriv(false); setShowSeed(false); } };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onVis);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onVis);
    };
  }, [showPriv, showSeed]);

  async function copyPrivateKey() {
    try {
      await navigator.clipboard.writeText(wallet?.privateKey ?? "");
      setPrivCopied(true);
      setTimeout(() => setPrivCopied(false), 2000);
    } catch {}
  }
  async function copySeedSettings() {
    try {
      await navigator.clipboard.writeText(wallet?.mnemonic ?? "");
      setSeedSettingsCopied(true);
      setTimeout(() => setSeedSettingsCopied(false), 2000);
    } catch {}
  }

  const [connectOpen, setConnectOpen] = useState(false);
  const [connectMode, setConnectMode] = useState<"choose" | "create" | "import">("choose");
  const [importMode, setImportMode] = useState<"seed" | "privkey">("seed");
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [importJson, setImportJson] = useState("");
  const [connectErr, setConnectErr] = useState("");
  const [creating, setCreating] = useState(false);

  // Seed-phrase reveal flow shown right after a successful create.
  const [seedRevealOpen, setSeedRevealOpen] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState("");
  const [seedConfirmed, setSeedConfirmed] = useState(false);
  const [seedCopied, setSeedCopied] = useState(false);

  useEffect(() => { document.title = "BLOB CHAIN — Proof-of-Gaming"; }, []);

  // Reset wallet-launch state on disconnect.
  useEffect(() => { if (!wallet) setGameLaunched(false); }, [wallet]);

  function resetConnect() {
    setConnectMode("choose");
    setImportMode("seed");
    setPass1(""); setPass2(""); setImportJson(""); setConnectErr("");
  }

  async function handleCreate() {
    if (pass1.length < 6) { setConnectErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setConnectErr("Passphrases do not match"); return; }
    setCreating(true); setConnectErr("");
    try {
      const r = await createWallet(pass1);
      if (!r.ok) { setConnectErr(r.error); return; }
      // Show seed phrase reveal dialog before closing connect flow.
      setSeedPhrase(r.mnemonic);
      setSeedConfirmed(false);
      setSeedCopied(false);
      setConnectOpen(false);
      resetConnect();
      setSeedRevealOpen(true);
    } catch (e: any) {
      setConnectErr(String(e?.message || e));
    } finally {
      setCreating(false);
    }
  }

  async function handleImport() {
    setConnectErr("");
    if (pass1.length < 6) { setConnectErr("Passphrase must be at least 6 characters"); return; }
    if (pass1 !== pass2) { setConnectErr("Passphrases do not match"); return; }
    try {
      const r = await importWallet(importJson, pass1);
      if (!r.ok) { setConnectErr(r.error); return; }
      setConnectOpen(false); resetConnect();
    } catch (e: any) {
      setConnectErr(String(e?.message || e));
    }
  }

  async function copySeedPhrase() {
    try {
      await navigator.clipboard.writeText(seedPhrase);
      setSeedCopied(true);
      setTimeout(() => setSeedCopied(false), 2000);
    } catch {}
  }

  async function handleUnlock() {
    setUnlockErr(""); setUnlocking(true);
    try {
      await unlockExisting(unlockPass);
      setUnlockOpen(false); setUnlockPass("");
    } catch (e: any) {
      setUnlockErr(String(e?.message || e));
    } finally {
      setUnlocking(false);
    }
  }

  const balance = wallet ? calcBalance(wallet.address, chain, mempool) : 0;
  const nav = [
    { id: "mine", text: "Mine" },
    { id: "wallet", text: "Wallet" },
    { id: "bridge", text: "Bridge" },
    { id: "chain", text: "Explorer" },
    { id: "network", text: "Network" },
  ];

  const openConnect = () => { resetConnect(); setConnectOpen(true); };
  const openUnlock = () => { setUnlockErr(""); setUnlockPass(""); setUnlockOpen(true); };

  const ConnectWalletDialog = (
    <Dialog open={connectOpen} onOpenChange={(o) => { setConnectOpen(o); if (!o) resetConnect(); }}>
      <DialogContent className="glass-hi border-border max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium tracking-wide">
            {connectMode === "choose" ? "Connect wallet" : connectMode === "create" ? "Create new wallet" : "Import wallet"}
          </DialogTitle>
        </DialogHeader>

        {connectMode === "choose" && (
          <div className="space-y-3 pt-1">
            <button
              onClick={() => { setConnectErr(""); setConnectMode("create"); }}
              className="w-full glass hover:ring-1 hover:ring-primary/40 transition p-4 flex items-center gap-4 text-left"
            >
              <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                <Plus className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">Create new wallet</div>
                <div className="text-xs text-muted-foreground">Generate a fresh secp256k1 keypair in your browser</div>
              </div>
            </button>
            <button
              onClick={() => { setConnectErr(""); setConnectMode("import"); }}
              className="w-full glass hover:ring-1 hover:ring-primary/40 transition p-4 flex items-center gap-4 text-left"
            >
              <div className="w-10 h-10 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary">
                <Download className="w-4 h-4" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium text-foreground">Import wallet</div>
                <div className="text-xs text-muted-foreground">Restore from an exported private key</div>
              </div>
            </button>
            <div className="text-[11px] text-muted-foreground/70 text-center pt-1">
              Keys never leave your device · Stored only in this browser
            </div>
          </div>
        )}

        {connectMode === "create" && (
          <div className="space-y-3 pt-1">
            <div>
              <label className="label-eyebrow block mb-2">Username</label>
              <input
                value={nameIn}
                onChange={e => setNameIn(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !creating && handleCreate()}
                placeholder="Blobtoshi"
                maxLength={24}
                autoFocus
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Passphrase</label>
              <input
                type="password" value={pass1} onChange={e => setPass1(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Confirm passphrase</label>
              <input
                type="password" value={pass2} onChange={e => setPass2(e.target.value)}
                onKeyDown={e => e.key === "Enter" && !creating && handleCreate()}
                placeholder="Repeat passphrase"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div className="flex items-start gap-2 p-3 rounded-lg border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)]">
              <ShieldAlert className="w-3.5 h-3.5 text-[hsl(var(--warning))] mt-0.5 flex-shrink-0" />
              <div className="text-[11px] text-foreground/80 leading-relaxed">
                After generating, you'll see a <span className="font-medium">12-word seed phrase</span>. Save it somewhere safe — it's the only way to recover this wallet on another device.
              </div>
            </div>
            {connectErr && <div className="text-xs text-destructive">{connectErr}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => setConnectMode("choose")}
                className="px-4 py-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition"
              >
                Back
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !nameIn.trim() || !pass1 || !pass2}
                className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {creating ? "Generating keypair…" : "Generate wallet"}
              </button>
            </div>
            <div className="text-[11px] text-muted-foreground/70 text-center pt-1">
              secp256k1 keypair generated on Blob Chain. (elliptic curve)
            </div>
          </div>
        )}

        {connectMode === "import" && (
          <div className="space-y-3 pt-1">
            <div>
              <label className="label-eyebrow block mb-2">Username</label>
              <input
                value={nameIn} onChange={e => setNameIn(e.target.value)}
                placeholder="Blobtoshi" maxLength={24}
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <div className="label-eyebrow mb-2">Restore using</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => { setImportMode("seed"); setImportJson(""); setConnectErr(""); }}
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition ${
                    importMode === "seed"
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <FileKey className="w-3.5 h-3.5" /> Seed phrase
                </button>
                <button
                  type="button"
                  onClick={() => { setImportMode("privkey"); setImportJson(""); setConnectErr(""); }}
                  className={`flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium border transition ${
                    importMode === "privkey"
                      ? "border-primary/60 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" /> Private key
                </button>
              </div>
              <label className="label-eyebrow block mb-2">
                {importMode === "seed" ? "12-word seed phrase" : "Private key (64 hex characters)"}
              </label>
              <textarea
                value={importJson} onChange={e => setImportJson(e.target.value)}
                placeholder={importMode === "seed"
                  ? "e.g. legal winner thank year wave sausage worth useful legal winner thank yellow"
                  : "e.g. 1e99423a4ed27608a15a2616a2b0e9e52ced330ac530edcc32c8ffc6a526aedd"}
                rows={3} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                className={`${importMode === "privkey" ? "num" : ""} w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-[12px] leading-relaxed resize-none break-all`}
              />
              <div className="text-[10px] text-muted-foreground/70 mt-1.5">
                {importMode === "seed"
                  ? "Your seed phrase regenerates your private key — username and passphrase are NOT used to import."
                  : "Paste the raw private key — username and passphrase are NOT used to import."}
              </div>
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Passphrase</label>
              <input
                type="password" value={pass1} onChange={e => setPass1(e.target.value)}
                placeholder="At least 6 characters"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            <div>
              <label className="label-eyebrow block mb-2">Confirm passphrase</label>
              <input
                type="password" value={pass2} onChange={e => setPass2(e.target.value)}
                placeholder="Repeat passphrase"
                className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
              />
            </div>
            {connectErr && <div className="text-xs text-destructive">{connectErr}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => setConnectMode("choose")}
                className="px-4 py-3 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground transition"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition"
              >
                Import wallet
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );

  const LockedGate = ({ context }: { context: "wallet" | "bridge" }) => (
    <div className="glass-hi p-10 text-center space-y-4">
      <div className="text-sm text-muted-foreground">{vaultPub ? "Wallet locked" : "No wallet connected"}</div>
      <button
        onClick={vaultPub ? openUnlock : openConnect}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition"
      >
        {vaultPub ? <><Lock className="w-4 h-4" /> Unlock wallet</> : <><Wallet className="w-4 h-4" /> Connect wallet</>}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen relative">
      {newBlock && (
        <div
          className={`fixed top-16 left-0 right-0 z-[1000] px-6 py-3 backdrop-blur-xl border-b text-center flex justify-center items-center gap-5 ${
            newBlock.isMine ? "bg-primary/15 border-primary/50 shadow-[0_0_40px_hsl(var(--primary)/0.35)]" : "bg-card/80 border-accent/40"
          }`}
        >
          <span className={`text-sm font-semibold tracking-wide ${newBlock.isMine ? "text-primary" : "text-accent"}`}>
            {newBlock.isMine ? "🏆 You mined block" : "New block"} #{newBlock.height}
          </span>
          <span className="text-xs text-muted-foreground">
            Winner: {newBlock.winnerUsername || "—"} · Score: <span className="num">{newBlock.winnerScore?.toLocaleString()}</span> · Reward: <span className="num text-foreground/80">{newBlock.reward} BLOB</span>
          </span>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-background/70 border-b border-border">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between gap-4">
          <h1 className="flex items-center -my-4">
            <img
              src={blobLogo}
              alt="BLOB"
              className="h-20 w-20 sm:h-24 sm:w-24 object-contain drop-shadow-[0_0_18px_hsl(var(--accent)/0.45)]"
              style={{ imageRendering: "pixelated" }}
            />
          </h1>

          <nav className="hidden sm:flex items-center gap-1">
            {nav.map(n => {
              const active = screen === n.id;
              return (
                <button
                  key={n.id}
                  onClick={() => setScreen(n.id)}
                  className={`relative px-4 py-2 text-sm font-medium transition ${active ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {n.text}
                  {active && (
                    <>
                      <span className="absolute left-3 right-5 -bottom-px h-[2px] bg-primary shadow-[0_0_10px_hsl(var(--primary))]" />
                      <span className="absolute right-2.5 -bottom-[3px] w-1 h-1 rounded-full bg-accent shadow-[0_0_8px_hsl(var(--accent))]" />
                    </>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex flex-col items-center px-3 py-1 rounded-full border border-primary/30 bg-primary/5">
              <span className="text-[9px] tracking-widest text-primary/80 leading-none">NETWORK</span>
              <span className="num text-[11px] text-primary leading-tight">{blockInfo.remaining}s</span>
            </div>

            {wallet && (
              <Dialog>
                <DialogTrigger asChild>
                  <button
                    className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-full text-xs font-medium border border-border hover:border-primary/40 hover:text-primary transition"
                    aria-label="Quick send"
                  >
                    <Send className="w-3.5 h-3.5" />
                    Send
                  </button>
                </DialogTrigger>
                <DialogContent className="glass-hi border-border max-w-md">
                  <DialogHeader>
                    <DialogTitle className="text-sm font-medium">Send BLOB</DialogTitle>
                  </DialogHeader>
                  <SendTxForm wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />
                </DialogContent>
              </Dialog>
            )}

            {wallet ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 px-3 py-2 rounded-full border border-border hover:border-primary/40 transition text-xs group">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                    <span className="hidden md:inline text-muted-foreground max-w-[100px] truncate">{wallet.username}</span>
                    <span className="num text-primary">{(Math.floor(balance * 100) / 100).toFixed(2)}</span>
                    <ChevronDown className="w-3 h-3 text-muted-foreground group-hover:text-primary transition" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="glass-hi border-border w-56">
                  <DropdownMenuLabel className="text-[10px] tracking-widest uppercase text-muted-foreground font-normal">
                    Connected as
                  </DropdownMenuLabel>
                  <div className="px-2 pb-2">
                    <div className="text-sm font-medium truncate">{wallet.username}</div>
                    <div className="num text-[10px] text-muted-foreground truncate">{wallet.address}</div>
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setScreen("wallet")} className="cursor-pointer">
                    <Wallet className="w-4 h-4 mr-2" /> Open wallet
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setScreen("bridge")} className="cursor-pointer">
                    <ArrowLeftRight className="w-4 h-4 mr-2" /> Bridge to Solana
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => { setShowPriv(false); setShowSeed(false); setSettingsOpen(true); }} className="cursor-pointer">
                    <SettingsIcon className="w-4 h-4 mr-2" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={disconnectWallet}
                    className="cursor-pointer text-destructive focus:text-destructive focus:bg-destructive/10"
                  >
                    <LogOut className="w-4 h-4 mr-2" /> Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : vaultPub ? (
              <button
                onClick={openUnlock}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground text-xs font-semibold tracking-wide hover:bg-primary/90 transition shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
              >
                <Lock className="w-3.5 h-3.5" />
                Unlock wallet
              </button>
            ) : (
              <button
                onClick={openConnect}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-primary text-primary-foreground text-xs font-semibold tracking-wide hover:bg-primary/90 transition shadow-[0_0_24px_hsl(var(--primary)/0.35)]"
              >
                <Wallet className="w-3.5 h-3.5" />
                Connect wallet
              </button>
            )}
          </div>
        </div>

        {/* Mobile nav */}
        <nav className="sm:hidden flex items-center justify-around border-t border-border/60">
          {nav.map(n => {
            const active = screen === n.id;
            return (
              <button
                key={n.id}
                onClick={() => setScreen(n.id)}
                className={`relative py-2.5 text-xs font-medium transition flex-1 ${active ? "text-primary" : "text-muted-foreground"}`}
              >
                {n.text}
                {active && <span className="absolute left-1/4 right-1/4 -bottom-px h-px bg-primary" />}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 sm:py-8 relative z-10">
        {screen === "mine" && (
          <div className="space-y-6">
            {!wallet ? (
              <div className="relative overflow-hidden rounded-3xl glass-hi px-6 py-16 sm:py-20 text-center">
                <div className="pointer-events-none absolute -top-24 left-1/2 -translate-x-1/2 w-[480px] h-[480px] rounded-full bg-primary/10 blur-3xl" />
                <div className="relative">
                  <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 border border-primary/30 text-primary mb-5">
                    <Lock className="w-5 h-5" />
                  </div>
                  <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight mb-3">
                    <span className="text-foreground">{vaultPub ? "Unlock to mine " : "Connect to mine "}</span>
                    <span className="text-primary drop-shadow-[0_0_24px_hsl(var(--primary)/0.5)]">BLOB</span>
                  </h1>
                  <div className="text-sm text-muted-foreground mb-8 max-w-md mx-auto leading-relaxed">
                    Blob Run requires a wallet to sign your score and receive block rewards.
                  </div>
                  <button
                    onClick={vaultPub ? openUnlock : openConnect}
                    className="inline-flex items-center gap-2 px-8 py-4 rounded-full bg-primary text-primary-foreground font-semibold text-sm tracking-wide hover:bg-primary/90 transition shadow-[0_0_40px_hsl(var(--primary)/0.4)]"
                  >
                    {vaultPub ? <Lock className="w-4 h-4" /> : <Wallet className="w-4 h-4" />}
                    {vaultPub ? "Unlock wallet" : "Connect wallet"}
                  </button>
                </div>
              </div>
            ) : !gameLaunched ? (
              <MineHero blockInfo={blockInfo} onLaunch={() => setGameLaunched(true)} />
            ) : (
              <BlobRunGame wallet={wallet} blockInfo={blockInfo} onEntrySubmit={onEntrySubmit} myEntry={myEntry} />
            )}
            <MiningPanel blockInfo={blockInfo} entries={entries} myEntry={myEntry} chain={chain} />
          </div>
        )}
        {screen === "wallet" && (
          wallet
            ? <WalletScreen wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />
            : <LockedGate context="wallet" />
        )}
        {screen === "bridge" && (
          wallet
            ? <BridgeScreen wallet={wallet} chain={chain} mempool={mempool} onBroadcast={onTxBroadcast} />
            : <LockedGate context="bridge" />
        )}
        {screen === "chain" && <BlockExplorer chain={chain} blockInfo={blockInfo} mempool={mempool} />}
        {screen === "network" && <NetworkView nodeCount={nodeCount} chain={chain} blockInfo={blockInfo} mempool={mempool} />}
      </main>

      {ConnectWalletDialog}

      {/* Seed-phrase reveal — shown once after wallet creation */}
      <Dialog
        open={seedRevealOpen}
        onOpenChange={(o) => {
          // Block close until the user confirms they've saved it.
          if (!o && !seedConfirmed) return;
          setSeedRevealOpen(o);
          if (!o) { setSeedPhrase(""); setSeedConfirmed(false); setSeedCopied(false); }
        }}
      >
        <DialogContent
          className="glass-hi border-border max-w-lg"
          onInteractOutside={(e) => { if (!seedConfirmed) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (!seedConfirmed) e.preventDefault(); }}
        >
          <DialogHeader>
            <DialogTitle className="text-sm font-medium tracking-wide flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-[hsl(var(--warning))]" />
              Save your 12-word seed phrase
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-1">
            <div className="text-xs text-muted-foreground leading-relaxed">
              This is the <span className="text-foreground font-medium">only way</span> to recover your wallet on another device or after clearing this browser. Write it down on paper or store it in a password manager. Never share it with anyone.
            </div>

            <div className="grid grid-cols-3 gap-2 p-4 rounded-lg border border-primary/30 bg-primary/5">
              {seedPhrase.split(" ").map((word, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-2.5 py-2 rounded-md bg-secondary/60 border border-border"
                >
                  <span className="text-[10px] text-muted-foreground num w-4 text-right">{i + 1}</span>
                  <span className="text-xs font-medium text-foreground">{word}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={copySeedPhrase}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:border-primary/40 text-xs text-muted-foreground hover:text-foreground transition"
              >
                {seedCopied ? <><Check className="w-3.5 h-3.5 text-primary" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy phrase</>}
              </button>
              <div className="text-[10px] text-muted-foreground/70 flex-1">
                Anyone with these 12 words controls your wallet.
              </div>
            </div>

            <label className="flex items-start gap-3 p-3 rounded-lg border border-border bg-secondary/30 cursor-pointer hover:border-primary/40 transition">
              <input
                type="checkbox"
                checked={seedConfirmed}
                onChange={(e) => setSeedConfirmed(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-primary cursor-pointer"
              />
              <span className="text-xs text-foreground/90 leading-relaxed">
                I have safely stored my 12-word seed phrase. I understand that losing it means losing access to my wallet, and that no one — including Blob Chain — can recover it for me.
              </span>
            </label>

            <button
              onClick={() => {
                setSeedRevealOpen(false);
                setSeedPhrase(""); setSeedConfirmed(false); setSeedCopied(false);
              }}
              disabled={!seedConfirmed}
              className="w-full py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              I've saved it — continue
            </button>
          </div>
        </DialogContent>
      </Dialog>


      <Dialog open={unlockOpen} onOpenChange={(o) => { setUnlockOpen(o); if (!o) { setUnlockPass(""); setUnlockErr(""); } }}>
        <DialogContent className="glass-hi border-border max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium tracking-wide">Unlock wallet</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-1">
            <div className="text-xs text-muted-foreground">
              {vaultPub?.username ? <>Welcome back, <span className="text-foreground">{vaultPub.username}</span></> : "Enter your passphrase to decrypt your wallet"}
            </div>
            <input
              type="password" value={unlockPass} onChange={e => setUnlockPass(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !unlocking && handleUnlock()}
              placeholder="Passphrase" autoFocus
              className="w-full px-4 py-3 rounded-lg bg-secondary/60 border border-border focus:border-primary/60 focus:outline-none text-sm"
            />
            {unlockErr && <div className="text-xs text-destructive">{unlockErr}</div>}
            <div className="flex gap-2">
              <button
                onClick={() => { disconnectWallet(); setUnlockOpen(false); }}
                className="px-4 py-3 rounded-lg border border-destructive/30 text-xs text-destructive hover:bg-destructive/10 transition"
              >
                Forget wallet
              </button>
              <button
                onClick={handleUnlock}
                disabled={unlocking || !unlockPass}
                className="flex-1 py-3 rounded-lg bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {unlocking ? "Decrypting…" : "Unlock"}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Settings dialog — public/private keys live here */}
      <Dialog open={settingsOpen} onOpenChange={(o) => { setSettingsOpen(o); if (!o) { setShowPriv(false); setShowSeed(false); } }}>
        <DialogContent className="glass-hi border-border max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-sm font-medium tracking-wide flex items-center gap-2">
              <SettingsIcon className="w-4 h-4 text-primary" /> Wallet settings
            </DialogTitle>
          </DialogHeader>
          {wallet && (
            <div className="space-y-4 pt-1">
              <div>
                <div className="label-eyebrow mb-2">Username</div>
                <div className="text-sm font-medium">{wallet.username}</div>
              </div>
              <div>
                <div className="label-eyebrow mb-2">Address</div>
                <div className="num text-xs text-foreground/80 break-all leading-relaxed p-3 rounded-md bg-secondary/40 border border-border">
                  {wallet.address}
                </div>
              </div>
              <div>
                <div className="label-eyebrow mb-2">Public key (secp256k1, compressed)</div>
                <div className="num text-[10px] text-muted-foreground break-all leading-relaxed p-3 rounded-md bg-secondary/40 border border-border">
                  {wallet.publicKey}
                </div>
              </div>

              {/* Seed phrase — only available for wallets created or imported via mnemonic */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="label-eyebrow flex items-center gap-1.5"><FileKey className="w-3 h-3" /> Seed phrase</div>
                  {wallet.mnemonic && (
                    <button
                      onClick={() => setShowSeed(v => !v)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border border-[hsl(var(--warning)/0.4)] text-[hsl(var(--warning))] hover:bg-[hsl(var(--warning)/0.08)] transition"
                    >
                      {showSeed ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Reveal</>}
                    </button>
                  )}
                </div>
                {!wallet.mnemonic ? (
                  <div className="text-[11px] text-muted-foreground p-3 rounded-md bg-secondary/40 border border-border">
                    No seed phrase available — this wallet was imported from a raw private key.
                  </div>
                ) : showSeed ? (
                  <div className="p-3 rounded-md border border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.06)] space-y-2">
                    <div className="text-[11px] text-[hsl(var(--warning))]">⚠ Anyone with these 12 words controls your wallet — never share or screenshot</div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {wallet.mnemonic.split(" ").map((word: string, i: number) => (
                        <div key={i} className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-card/60 border border-border">
                          <span className="text-[9px] text-muted-foreground/60 num w-4">{i + 1}</span>
                          <span className="text-[11px] font-medium">{word}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={copySeedSettings}
                      className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] border border-border hover:border-primary/40 hover:text-primary transition"
                    >
                      {seedSettingsCopied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy seed phrase</>}
                    </button>
                  </div>
                ) : (
                  <div className="text-[10px] text-muted-foreground/50 leading-relaxed p-3 rounded-md bg-secondary/40 border border-border select-none">
                    •••• •••• •••• •••• •••• •••• •••• •••• •••• •••• •••• ••••
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="label-eyebrow flex items-center gap-1.5"><KeyRound className="w-3 h-3" /> Private key</div>
                  <div className="flex items-center gap-1.5">
                    {showPriv && (
                      <button
                        onClick={copyPrivateKey}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border border-border hover:border-primary/40 hover:text-primary transition"
                      >
                        {privCopied ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy</>}
                      </button>
                    )}
                    <button
                      onClick={() => setShowPriv(v => !v)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] border border-destructive/30 text-destructive hover:bg-destructive/10 transition"
                    >
                      {showPriv ? <><EyeOff className="w-3 h-3" /> Hide</> : <><Eye className="w-3 h-3" /> Reveal</>}
                    </button>
                  </div>
                </div>
                {showPriv ? (
                  <div className="p-3 rounded-md border border-destructive/30 bg-destructive/5 space-y-1.5">
                    <div className="text-[11px] text-destructive">⚠ Never share this key — anyone with it controls your wallet. </div>
                    <div className="num text-[10px] text-foreground/70 break-all leading-relaxed">{wallet.privateKey}</div>
                  </div>
                ) : (
                  <div className="num text-[10px] text-muted-foreground/50 break-all leading-relaxed p-3 rounded-md bg-secondary/40 border border-border select-none">
                    {"•".repeat(64)}
                  </div>
                )}
              </div>
              <div className="pt-2 border-t border-border flex gap-2">
                <button
                  onClick={() => { disconnectWallet(); setSettingsOpen(false); }}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg border border-destructive/30 text-xs text-destructive hover:bg-destructive/10 transition"
                >
                  <LogOut className="w-3.5 h-3.5" /> Disconnect wallet
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <footer className="mt-12 py-6 text-center text-[11px] text-muted-foreground/60 num">
        Blob Chain © 2026
      </footer>
    </div>
  );
}
