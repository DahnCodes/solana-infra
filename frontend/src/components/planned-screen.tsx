import { Construction } from "lucide-react";
import Link from "next/link";
import { Panel } from "./panel";

/**
 * Placeholder for a screen that a later checklist step builds, so the
 * navigation works end to end in the meantime. Each use is replaced by the
 * real screen.
 */
export function PlannedScreen({ step, what }: { step: string; what: string }) {
  return (
    <Panel>
      <div className="flex items-start gap-4">
        <Construction
          aria-hidden
          className="mt-1 size-6 shrink-0 text-ink-muted"
        />
        <div className="flex flex-col gap-2">
          <h2 className="text-h5 font-medium">
            This screen is next on the build list
          </h2>
          <p className="text-body text-ink-secondary">
            {what} Built in checklist step {step}. Until then,{" "}
            <Link
              href="/mock"
              className="text-ink underline underline-offset-4"
            >
              the mock data page
            </Link>{" "}
            shows the same data.
          </p>
        </div>
      </div>
    </Panel>
  );
}
