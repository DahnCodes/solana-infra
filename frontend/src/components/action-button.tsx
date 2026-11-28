"use client";

import { useState, type ReactNode } from "react";
import { Button, type ButtonVariant } from "@/components/button";
import { useTx, type TxRequest } from "@/components/tx/tx-provider";
import type { BreakglassClient } from "@/lib/breakglass";
import type { Permission } from "@/lib/breakglass/permissions";

export { explainError } from "@/components/tx/tx-provider";

/**
 * One write behind a permission check. Role awareness (step 4.9):
 * - not `relevant` (the role can never do this here): not shown at all;
 * - relevant but not allowed right now: disabled, with the reason beside it;
 * - allowed: asks for confirmation with a plain summary (step 5.1), then
 *   sends it with a spinner and reports the outcome.
 */
export function ActionButton<R>({
  label,
  done,
  icon,
  variant,
  permission,
  relevant = true,
  confirm,
  run,
}: {
  label: string;
  /** The toast after it is confirmed, such as "Hold frozen". */
  done: TxRequest<R>["done"];
  icon?: ReactNode;
  variant?: ButtonVariant;
  permission: Permission;
  /** Whether the current role could ever take this action here. */
  relevant?: boolean;
  /** The confirm dialog: question, plain summary, key facts. */
  confirm: Pick<TxRequest<R>, "title" | "summary" | "details" | "signs"> & {
    confirmLabel?: string;
  };
  run: (client: BreakglassClient) => Promise<R>;
}) {
  const tx = useTx();
  const [pending, setPending] = useState(false);
  if (!relevant) return null;

  const button = (
    <Button
      variant={variant}
      icon={icon}
      pending={pending}
      disabled={!permission.allowed}
      onClick={async () => {
        await tx.send({
          ...confirm,
          confirmLabel: confirm.confirmLabel ?? label,
          run,
          done,
          onStart: () => setPending(true),
        });
        setPending(false);
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
