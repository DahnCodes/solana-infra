"use client";

import { useConnection } from "@solana/wallet-adapter-react";
import { useEffect, useState } from "react";
import { networkProblem, type NetworkProblem } from "@/lib/cluster";
import { env } from "@/lib/env";

// One genesis lookup per RPC endpoint for the life of the page.
const genesisByEndpoint = new Map<string, Promise<string | null>>();

function genesisOf(
  endpoint: string,
  fetchGenesis: () => Promise<string>,
): Promise<string | null> {
  let pending = genesisByEndpoint.get(endpoint);
  if (!pending) {
    // An unreachable RPC isn't a wrong network; it just can't be checked.
    pending = fetchGenesis().catch(() => null);
    genesisByEndpoint.set(endpoint, pending);
  }
  return pending;
}

/**
 * The configured cluster and anything wrong with the network setup: the app
 * set to mainnet, or an RPC endpoint that answers for another cluster.
 */
export function useNetwork(): {
  cluster: typeof env.cluster;
  problem: NetworkProblem | null;
} {
  const { connection } = useConnection();
  const [genesis, setGenesis] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    genesisOf(connection.rpcEndpoint, () => connection.getGenesisHash()).then(
      (hash) => {
        if (active) setGenesis(hash);
      },
    );
    return () => {
      active = false;
    };
  }, [connection]);

  return {
    cluster: env.cluster,
    problem: networkProblem(env.cluster, genesis),
  };
}
