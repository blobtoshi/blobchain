// Tight Solana wallet adapter setup for the reverse-bridge flow.
// Loads only Phantom + Solflare to keep the bundle small and to avoid the
// hardware-wallet packages (Ledger pulls native `usb` deps).
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";

// Browser-friendly public fallback. The default `api.mainnet-beta.solana.com`
// blocks browser-origin RPC calls with 403; publicnode allows CORS but is
// rate-limited. Prefer a configured `SOLANA_RPC_URL` secret via bridge-config.
const FALLBACK_RPC = "https://solana-rpc.publicnode.com";

export default function SolanaProvider({
  children,
  endpoint: endpointProp,
}: {
  children: ReactNode;
  endpoint?: string | null;
}) {
  const endpoint = useMemo(
    () => endpointProp || (import.meta as any).env.VITE_SOLANA_RPC_URL || FALLBACK_RPC,
    [endpointProp],
  );
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
