import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { MockData } from "./mock-data";

export const metadata: Metadata = { title: "Mock data · Breakglass" };

// Temporary check for checklist step 2.4: every figure here comes from the
// data hooks and refreshes after each action. Replaced by the protocol
// dashboard in step 4.4.
export default function MockDataPage() {
  return (
    <>
      <PageHeader
        title="Mock data"
        description="The demo gate, read through the data hooks. Act as any wallet and watch every figure update."
      />
      <MockData />
    </>
  );
}
