import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlannedScreen } from "@/components/planned-screen";

export const metadata: Metadata = { title: "Overview · Breakglass" };

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="The protocol at a glance: pauses, the withdrawal window, holds, pending changes and incidents."
      />
      <PlannedScreen
        step="4.4"
        what="The overview shows every scope's pause state, each token's window usage against its cap, open holds, pending changes, the guardian's budget and open incidents."
      />
    </>
  );
}
