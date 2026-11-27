import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlannedScreen } from "@/components/planned-screen";

export const metadata: Metadata = { title: "Pauses and rules · Breakglass" };

export default function PausesandrulesPage() {
  return (
    <>
      <PageHeader
        title="Pauses and rules"
        description="Pause controls and the timelocked config changes."
      />
      <PlannedScreen
        step="4.7"
        what="Pause, renew and lift scopes within the guardian's limits, and propose, veto, cancel or execute config changes."
      />
    </>
  );
}
