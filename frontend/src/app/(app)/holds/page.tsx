import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlannedScreen } from "@/components/planned-screen";

export const metadata: Metadata = { title: "Held withdrawals · Breakglass" };

export default function HeldwithdrawalsPage() {
  return (
    <>
      <PageHeader
        title="Held withdrawals"
        description="Withdrawals waiting out their hold, with who can act on each."
      />
      <PlannedScreen
        step="4.6"
        what="Each held withdrawal with its countdown and risk flags; the guardian freezes, the admin rejects, the owner claims."
      />
    </>
  );
}
