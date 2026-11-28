import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { RegisterFlow } from "./register-flow";

export const metadata: Metadata = { title: "Register a protocol · Breakglass" };

export default function RegisterPage() {
  return (
    <>
      <PageHeader
        title="Register a protocol"
        description="Put a protocol behind the gate: who guards it, what can never be paused, and how much can leave per window."
      />
      <RegisterFlow />
    </>
  );
}
