import type { Metadata } from "next";
import { Showcase } from "./showcase";

export const metadata: Metadata = { title: "Components · Breakglass" };

// Every base component, side by side in light and dark (checklist step 1.3).
export default function ComponentsPage() {
  return (
    <main className="mx-auto flex w-full max-w-content flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-h3">Components</h1>
        <p className="text-title1 text-ink-secondary">
          The base components, in light and dark.
        </p>
      </header>
      <Showcase />
    </main>
  );
}
