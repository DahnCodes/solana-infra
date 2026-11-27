"use client";

import {
  ConnectionProvider,
  useWallet,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { useEffect, useRef, type ReactNode } from "react";
import { getMockClient } from "@/lib/breakglass/create-client";
import { MOCK_WALLETS } from "@/lib/breakglass/mock/seed";
import { env } from "@/lib/env";
import { reportWalletError } from "./wallet-errors";

// Phantom, Solflare and Backpack all speak the Wallet Standard, so the
// adapter finds them by itself; no per-wallet adapters are listed.
const WALLETS: never[] = [];

/**
 * Solana connection and wallet state for the whole app. The RPC endpoint is
 * NEXT_PUBLIC_RPC_URL. The last wallet used reconnects on load.
 */
export function SolanaProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={env.rpcUrl}>
      <WalletProvider wallets={WALLETS} autoConnect onError={reportWalletError}>
        <MockWalletSync />
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}

/**
 * In mock mode, a connected real wallet becomes the wallet the mock acts as,
 * so a judge's own key is a fresh user in the demo. Disconnecting returns to
 * the demo user. Without a real wallet, the role switcher stays in charge.
 */
function MockWalletSync() {
  const { publicKey } = useWallet();
  const address = publicKey?.toBase58() ?? null;
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const mock = getMockClient();
    if (!mock) return;
    if (address) mock.setWallet(address);
    else if (previous.current) mock.setWallet(MOCK_WALLETS.user.address);
    previous.current = address;
  }, [address]);

  return null;
}
