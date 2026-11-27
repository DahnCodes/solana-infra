import type { ComponentProps } from "react";
import { cx } from "@/lib/cx";

export type Status = "open" | "held" | "tripped";

const dot: Record<Status, string> = {
  open: "bg-open",
  held: "bg-held",
  tripped: "bg-tripped",
};

type BadgeProps = ComponentProps<"span"> & {
  /** Adds a status dot. The label must still say the status in words. */
  status?: Status;
};

/** A small label chip, such as a role, a scope or a status. */
export function Badge({ status, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-control bg-surface-inset px-2 py-1 font-label text-caption font-semibold text-ink",
        className,
      )}
      {...rest}
    >
      {status && (
        <span
          aria-hidden
          className={cx("size-2 shrink-0 rounded-full", dot[status])}
        />
      )}
      {children}
    </span>
  );
}
