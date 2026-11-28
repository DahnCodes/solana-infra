import type { Cluster } from "./env";

/**
 * A Solana Explorer link for a transaction on the given cluster. A local
 * validator is reached through Explorer's custom-cluster setting.
 */
export function explorerTxUrl(
  signature: string,
  cluster: Cluster,
  rpcUrl: string,
): string {
  const base = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  switch (cluster) {
    case "mainnet-beta":
      return base;
    case "devnet":
      return `${base}?cluster=devnet`;
    case "localnet":
      return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
  }
}
