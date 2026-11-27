import type { Cluster } from "./env";

/** Display names for each cluster. */
export const CLUSTER_LABELS: Record<Cluster, string> = {
  localnet: "Localnet",
  devnet: "Devnet",
  "mainnet-beta": "Mainnet",
};

/**
 * Genesis hashes of the public clusters: what getGenesisHash() returns on
 * each. A local validator gets a new one every reset, so it has none.
 */
export const GENESIS_HASHES: Record<Exclude<Cluster, "localnet">, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

const TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/** Which cluster a genesis hash belongs to, or "other" (a local validator). */
export function clusterOfGenesis(hash: string): Cluster | "testnet" | "other" {
  if (hash === GENESIS_HASHES.devnet) return "devnet";
  if (hash === GENESIS_HASHES["mainnet-beta"]) return "mainnet-beta";
  if (hash === TESTNET_GENESIS) return "testnet";
  return "other";
}

export type NetworkProblem =
  | { kind: "mainnet" }
  | {
      kind: "mismatch";
      expected: Cluster;
      actual: Cluster | "testnet" | "other";
    };

/**
 * What is wrong with the network setup, or null. Breakglass runs on devnet
 * (or a local validator); mainnet is never right, and an RPC that answers
 * for another cluster than the configured one means the config is wrong.
 */
export function networkProblem(
  configured: Cluster,
  rpcGenesis: string | null,
): NetworkProblem | null {
  if (configured === "mainnet-beta") return { kind: "mainnet" };
  if (rpcGenesis === null) return null;
  const actual = clusterOfGenesis(rpcGenesis);
  if (actual === "mainnet-beta") return { kind: "mainnet" };
  const matches =
    configured === "localnet" ? actual === "other" : actual === configured;
  return matches ? null : { kind: "mismatch", expected: configured, actual };
}
