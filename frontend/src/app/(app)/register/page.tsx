import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlannedScreen } from "@/components/planned-screen";

export const metadata: Metadata = { title: "Register a protocol · Breakglass" };

export default function RegisteraprotocolPage() {
  return (
    <>
      <PageHeader
        title="Register a protocol"
        description="Put a protocol behind the gate."
      />
      <PlannedScreen
        step="4.3"
        what="Register a protocol (guardians, unpausable scopes, timelock) and set up a limiter for each token."
      />
    </>
  );
}
