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
 * One write behind a permission check: disabled with the reason when it
 * isn't allowed (or hidden, for actions that don't apply), a spinner while
 * it is in flight, and a toast when it settles.
 */
export function ActionButton({
  label,
  done,
  icon,
  variant,
  permission,
  hideWhenDenied = false,
  run,
  onDone,
}: {
  label: string;
  /** The toast title on success, such as "Hold frozen". */
  done: string;
  icon?: ReactNode;
  variant?: ButtonVariant;
  permission: Permission;
  hideWhenDenied?: boolean;
  run: (client: BreakglassClient) => Promise<unknown>;
  onDone?: (result: unknown) => void;
}) {
  const toast = useToast();
  const write = useWrite(run);
  if (!permission.allowed && hideWhenDenied) return null;
  return (
    <Button
      variant={variant}
      icon={icon}
      pending={write.pending}
      disabled={!permission.allowed}
      title={permission.allowed ? undefined : permission.reason}
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
}
