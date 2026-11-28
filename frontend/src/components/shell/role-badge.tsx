"use client";

import { Badge } from "@/components/badge";
import {
  roleOf,
  useConnectedWallet,
  useProtocol,
} from "@/hooks/use-breakglass";
import { useHydrated } from "@/hooks/use-hydrated";

const LABEL = { admin: "Admin", guardian: "Guardian", user: "User" } as const;

/** What the connected wallet is to the protocol, so actions make sense. */
export function RoleBadge() {
  const hydrated = useHydrated();
  const wallet = useConnectedWallet();
  const protocol = useProtocol();
  if (!hydrated || !wallet || !protocol.data) return null;
  const role = roleOf(protocol.data.account, wallet);
  if (!role) return null;
  return (
    <Badge title="What your wallet can do in this protocol">
      Acting as {LABEL[role]}
    </Badge>
  );
}
