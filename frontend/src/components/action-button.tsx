"use client";

import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/button";
import { useToast } from "@/components/toast";
import { useWrite } from "@/hooks/use-write";
import type { BreakglassClient } from "@/lib/breakglass";
import { isClientError } from "@/lib/breakglass/errors";
import { messageFor } from "@/lib/breakglass/messages";
import type { Permission } from "@/lib/breakglass/permissions";

/** What a failed write means, in words. */
export function explainError(error: unknown): string {
  if (!isClientError(error)) return "Something went wrong. Try again.";
  return messageFor(error.errorName) ?? error.message;
}

/**
 * One write behind a permission check. Role awareness (step 4.9):
 * - not `relevant` (the role can never do this here): not shown at all;
 * - relevant but not allowed right now: disabled, with the reason beside it;
 * - allowed: a spinner while in flight, then a toast.
 */
export function ActionButton({
  label,
  done,
  icon,
  variant,
  permission,
  relevant = true,
  run,
  onDone,
}: {
  label: string;
  /** The toast title on success, such as "Hold frozen". */
  done: string;
  icon?: ReactNode;
  variant?: ButtonVariant;
  permission: Permission;
  /** Whether the current role could ever take this action here. */
  relevant?: boolean;
  run: (client: BreakglassClient) => Promise<unknown>;
  onDone?: (result: unknown) => void;
}) {
  const toast = useToast();
  const write = useWrite(run);
  if (!relevant) return null;

  const button = (
    <Button
      variant={variant}
      icon={icon}
      pending={write.pending}
      disabled={!permission.allowed}
      onClick={async () => {
        try {
          const result = await write.run();
          const held =
            result !== null &&
            typeof result === "object" &&
            "decision" in result &&
            result.decision === "hold";
          toast.show(
            held
              ? {
                  tone: "held",
                  title: "Not claimed yet",
                  description:
                    "Claiming now would cross the window's cap, so withdrawals paused. Try again once the window frees up.",
                }
              : { tone: "open", title: done },
          );
          onDone?.(result);
        } catch (error) {
          toast.show({
            tone: "tripped",
            title: `${label} didn't go through`,
            description: explainError(error),
          });
        }
      }}
    >
      {label}
    </Button>
  );

  if (permission.allowed) return button;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {button}
      <span className="text-body text-ink-muted">{permission.reason}</span>
    </span>
  );
}
