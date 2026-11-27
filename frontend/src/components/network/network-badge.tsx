"use client";

import { Badge } from "@/components/badge";
import { CLUSTER_LABELS } from "@/lib/cluster";
import { env } from "@/lib/env";
import { useNetwork } from "./use-network";

/**
 * Which network the app is on, and whether its data is the mock. Mainnet or
 * a mismatched RPC turns the badge into a warning; the banner explains.
 */
export function NetworkBadge() {
  const { cluster, problem } = useNetwork();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge
        status={problem ? "tripped" : undefined}
        title={
          problem ? "Wrong network: see the warning at the top" : undefined
        }
      >
        {CLUSTER_LABELS[cluster]}
      </Badge>
      {env.dataMode === "mock" && (
        <Badge title="Figures come from the in-browser demo, not the chain">
          Mock data
        </Badge>
      )}
    </span>
  );
}
