import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlannedScreen } from "@/components/planned-screen";

export const metadata: Metadata = {
  title: "Deposit and withdraw · Breakglass",
};

export default function DepositandwithdrawPage() {
  return (
    <>
      <PageHeader
        title="Deposit and withdraw"
        description="Move funds in and out of the test vault. Every withdrawal passes the gate."
      />
      <PlannedScreen
        step="4.5"
        what="Deposit into the test vault, withdraw, and see the gate's answer: sent, held until a time, or paused."
      />
    </>
  );
}
