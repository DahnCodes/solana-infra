import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { PlannedScreen } from "@/components/planned-screen";

export const metadata: Metadata = { title: "Activity · Breakglass" };

export default function ActivityPage() {
  return (
    <>
      <PageHeader
        title="Activity"
        description="Every Breakglass event, with its time and who did it."
      />
      <PlannedScreen
        step="4.8"
        what="The event feed and the monitor's incidents."
      />
    </>
  );
}
