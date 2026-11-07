"use client";

import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, useWallet, WalletProvider } from "@solana/wallet-adapter-react";
import { useWalletModal, WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./wallet-modal.css";

const DEVNET = "https://api.devnet.solana.com";
const WALLET_STORAGE_KEY = "pescrow-wallet";
const WALLET_LIST_BUTTON = ".wallet-adapter-modal-list .wallet-adapter-button";

export function WalletFrame({ children }: { children: ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet })],
    [],
  );
  return (
    <ConnectionProvider endpoint={DEVNET}>
      <WalletProvider wallets={wallets} autoConnect={false} localStorageKey={WALLET_STORAGE_KEY}>
        <WalletModalProvider>
          <ConnectPickedWallet />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function ConnectPickedWallet() {
  const { connect, connected, connecting } = useWallet();
  const { visible } = useWalletModal();
  const picked = useRef(false);

  useEffect(() => {
    if (!visible) return;
    function rememberPick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(WALLET_LIST_BUTTON) !== null) picked.current = true;
    }
    document.addEventListener("click", rememberPick, true);
    return () => document.removeEventListener("click", rememberPick, true);
  }, [visible]);

  useEffect(() => {
    if (visible || !picked.current || connected || connecting) return;
    picked.current = false;
    void connect().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "The wallet did not connect.");
    });
  }, [visible, connected, connecting, connect]);

  return null;
}
