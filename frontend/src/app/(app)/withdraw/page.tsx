import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { VaultForms } from "./vault-forms";

export const metadata: Metadata = {
  title: "Deposit and withdraw · Breakglass",
};

export default function WithdrawPage() {
  return (
    <>
      <PageHeader
        title="Deposit and withdraw"
        description="Move funds in and out of the test vault. Every withdrawal asks the gate first: sent at once, held in public, or paused."
      />
      <VaultForms />
    </>
  );
}
