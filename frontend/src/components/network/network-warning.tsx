"use client";

import { TriangleAlert } from "lucide-react";
import { CLUSTER_LABELS, type NetworkProblem } from "@/lib/cluster";
import { useNetwork } from "./use-network";

const name = (c: string) =>
  c in CLUSTER_LABELS
    ? CLUSTER_LABELS[c as keyof typeof CLUSTER_LABELS]
    : c === "testnet"
      ? "Testnet"
      : "a local validator";

function message(problem: NetworkProblem): { title: string; detail: string } {
  if (problem.kind === "mainnet") {
    return {
      title: "This app is pointed at Solana mainnet.",
      detail:
        "Breakglass runs on devnet only. Don't connect a wallet that holds real funds; switch the app and your wallet to devnet.",
    };
  }
  return {
    title: `The RPC endpoint is on ${name(problem.actual)}, but the app expects ${name(problem.expected)}.`,
    detail:
      "Accounts and transactions won't match. Point NEXT_PUBLIC_RPC_URL at the right cluster.",
  };
}

/** A full-width warning at the top of every page when the network is wrong. */
export function NetworkWarning() {
  const { problem } = useNetwork();
  if (!problem) return null;
  const { title, detail } = message(problem);
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6"
    >
      <TriangleAlert
        aria-hidden
        className="mt-0.5 size-5 shrink-0 text-tripped"
      />
      <p className="text-body">
        <span className="font-medium">{title}</span>{" "}
        <span className="text-ink-secondary">{detail}</span>
      </p>
    </div>
  );
}
