import { useEffect, useMemo, useState } from "react";
import { calcBalance } from "@web/lib/blob/chain";
import { useWallet } from "./hooks/useWallet";
import { useNodeClient } from "./hooks/useNodeClient";
import { useNodeConfig } from "./hooks/useNodeConfig";
import { SetupScreen } from "./screens/SetupScreen";
import { UnlockScreen } from "./screens/UnlockScreen";
import { WalletTab } from "./screens/WalletTab";
import { SendTab } from "./screens/SendTab";
import { NodeTab } from "./screens/NodeTab";

declare global {
  interface Window {
    menuBridge?: { onMenuEvent(cb: (event: string) => void): () => void };
  }
}

type Tab = "wallet" | "send" | "node";

export default function App() {
  const wallet = useWallet({ idleLockMs: 5 * 60 * 1000, lockOnBlur: false });
  const { nodeUrl, setNodeUrl, savedUrls, setSavedUrls } = useNodeConfig();
  const node = useNodeClient(nodeUrl);
  const [tab, setTab] = useState<Tab>("wallet");

  // Reset to wallet tab whenever a fresh unlock happens.
  useEffect(() => { if (wallet.plain) setTab("wallet"); }, [wallet.plain]);

  // Native menu + global keyboard shortcuts.
  useEffect(() => {
    const offMenu = window.menuBridge?.onMenuEvent((evt) => {
      if (evt === "lock") wallet.lock();
      else if (evt === "tab:wallet") setTab("wallet");
      else if (evt === "tab:send") setTab("send");
      else if (evt === "tab:node") setTab("node");
    });
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "l" || e.key === "L") { e.preventDefault(); wallet.lock(); }
      else if (e.key === "1") { e.preventDefault(); setTab("wallet"); }
      else if (e.key === "2") { e.preventDefault(); setTab("send"); }
      else if (e.key === "3") { e.preventDefault(); setTab("node"); }
    };
    window.addEventListener("keydown", onKey);
    return () => { offMenu?.(); window.removeEventListener("keydown", onKey); };
  }, [wallet.lock]);

  const balance = useMemo(() => {
    if (!wallet.pub) return 0;
    return calcBalance(wallet.pub.address, node.chain, node.mempool);
  }, [wallet.pub, node.chain, node.mempool]);

  if (wallet.loading) {
    return <div className="app"><div className="content"><div className="muted">Loading…</div></div></div>;
  }

  const statusClass = node.status === "open" ? "ok"
    : node.status === "syncing" || node.status === "connecting" ? "warn"
    : "err";

  return (
    <div className="app">
      <header className="header">
        <h1>BLOB Wallet</h1>
        <span className={`badge ${statusClass}`}>
          {!node.online ? "offline" : node.status} · h{node.tipHeight}
        </span>
      </header>

      {!wallet.pub ? (
        <SetupScreen onCreated={wallet.setPub} />
      ) : !wallet.plain ? (
        <UnlockScreen pub={wallet.pub} onUnlock={wallet.unlock} onForget={wallet.forget} />
      ) : (
        <>
          <nav className="tabs">
            <button className={tab === "wallet" ? "active" : ""} onClick={() => setTab("wallet")}>Wallet</button>
            <button className={tab === "send" ? "active" : ""} onClick={() => setTab("send")}>Send</button>
            <button className={tab === "node" ? "active" : ""} onClick={() => setTab("node")}>Node</button>
          </nav>
          <div className="content">
            {tab === "wallet" && (
              <WalletTab wallet={wallet.plain} balance={balance} onLock={wallet.lock} />
            )}
            {tab === "send" && (
              <SendTab wallet={wallet.plain} balance={balance} client={node.client} status={node.status} />
            )}
            {tab === "node" && (
              <NodeTab
                nodeUrl={nodeUrl} setNodeUrl={setNodeUrl}
                savedUrls={savedUrls} setSavedUrls={setSavedUrls}
                status={node.status} tipHeight={node.tipHeight}
                mempoolSize={node.mempool.length} chainSize={node.chain.length}
                online={node.online}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
