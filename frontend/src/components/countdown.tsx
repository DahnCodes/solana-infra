"use client";

import { useNow } from "@/hooks/use-now";
import { cx } from "@/lib/cx";
import { formatDateTime, formatDuration } from "@/lib/format";
import type { FigureSize } from "./amount";

const sizes: Record<FigureSize, string> = {
  inline: "text-body",
  card: "font-figure text-h4 font-light",
  hero: "font-figure text-h1 font-light",
};

type CountdownProps = {
  /** When it ends, as unix seconds (such as a hold's `releaseAt`). */
  target: number;
  /** Current unix time from a simulated clock; defaults to the real one. */
  now?: number;
  size?: FigureSize;
  /** Shown once the target has passed. */
  doneLabel?: string;
  /** Shows the target date and time under the figure. */
  showTarget?: boolean;
  className?: string;
};

/** Time left until `target`, ticking every second. */
export function Countdown({
  target,
  now: nowOverride,
  size = "inline",
  doneLabel = "Ready",
  showTarget = size !== "inline",
  className,
}: CountdownProps) {
  const liveNow = useNow();
  const now = nowOverride ?? liveNow;
  const left = now === null ? null : target - now;
  const done = left !== null && left <= 0;

  return (
    <span className={cx("inline-flex flex-col gap-1", className)}>
      <span
        role="timer"
        className={cx("whitespace-nowrap tabular-nums", sizes[size])}
      >
        {left === null ? "--:--:--" : done ? doneLabel : formatDuration(left)}
      </span>
      {showTarget && (
        <span className="text-body text-ink-muted">
          {now === null
            ? " "
            : `${done ? "Ended" : "Ends"} ${formatDateTime(target)}`}
        </span>
      )}
    </span>
  );
}
