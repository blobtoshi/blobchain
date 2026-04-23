// @ts-nocheck
// Tight Solana wallet adapter setup for the reverse-bridge flow.
// Loads only Phantom + Solflare to keep the bundle small and to avoid the
// hardware-wallet packages (Ledger pulls native `usb` deps).
import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

export default function SolanaProvider({ children }: { children: ReactNode }) {
  const endpoint = useMemo(
    () => (import.meta as any).env.VITE_SOLANA_RPC_URL || DEFAULT_RPC,
    [],
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
