import { cx } from "@/lib/cx";

const TICKS = 60;

/** Whole percent of `part` in `whole`, without losing bigint precision. */
function percentOf(part: bigint, whole: bigint): number {
  if (whole <= BigInt(0)) return part > BigInt(0) ? 100 : 0;
  return Number((part * BigInt(10_000)) / whole) / 100;
}

/**
 * How much of a window's cap is used: a row of thin ticks, filled in the
 * primary colour up to the share used, ending at a red cap mark. Borrowed
 * from the Parallel reference's progress bar. Status stays in small doses:
 * a tripped cap is told by the card's badge, not by turning the meter red.
 */
export function WindowMeter({
  used,
  cap,
  label,
}: {
  used: bigint;
  cap: bigint;
  /** Read out with the percentage, such as "USDC window used". */
  label: string;
}) {
  const share = percentOf(used, cap);
  const filled = Math.min(TICKS, Math.round((share / 100) * TICKS));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(100, Math.round(share))}
      aria-valuetext={`${share.toFixed(1)}% of the cap`}
      className="flex h-10 items-center justify-between"
    >
      {Array.from({ length: TICKS }, (_, i) => (
        <span
          key={i}
          className={cx(
            "w-[3px] rounded-full",
            i < filled ? "h-10 bg-primary" : "h-6 bg-line-strong",
          )}
        />
      ))}
      <span aria-hidden className="h-10 w-[3px] rounded-full bg-tripped" />
    </div>
  );
}

/**
 * The window's sub-buckets, oldest first: one bar per bucket, height by
 * outflow. Shows when withdrawals happened and which will roll off next.
 */
export function BucketBars({
  buckets,
  label,
}: {
  buckets: bigint[];
  label: string;
}) {
  const max = buckets.reduce((m, b) => (b > m ? b : m), BigInt(0));
  return (
    <div role="img" aria-label={label} className="flex h-12 items-end gap-1">
      {buckets.map((b, i) => {
        const pct = max > BigInt(0) ? percentOf(b, max) : 0;
        return (
          <span
            key={i}
            className={cx(
              "flex-1 rounded-t-[2px]",
              b > BigInt(0) ? "bg-ink-secondary" : "bg-line",
            )}
            style={{ height: `${Math.max(pct, 6)}%` }}
          />
        );
      })}
    </div>
  );
}
