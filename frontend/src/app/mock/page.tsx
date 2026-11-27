import type { Metadata } from "next";
import { MockData } from "./mock-data";

export const metadata: Metadata = { title: "Mock data · Breakglass" };

// Temporary check for checklist step 2.4: every figure here comes from the
// data hooks and refreshes after each action. Replaced by the protocol
// dashboard in step 4.4.
export default function MockDataPage() {
  return (
    <main className="mx-auto flex w-full max-w-content flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-h3">Mock data</h1>
        <p className="text-title1 text-ink-secondary">
          The demo gate, read through the data hooks. Act as any wallet and
          watch every figure update.
        </p>
      </header>
      <MockData />
    </main>
  );
}
