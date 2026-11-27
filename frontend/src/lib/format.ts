/**
 * Formatting helpers. Token amounts are u64 base units: they arrive as bigint
 * or as a decimal string (the monitor API), never as a JS number.
 */

/**
 * Formats base units as a decimal amount with thousands separators.
 * Extra fraction digits beyond `maxFractionDigits` are cut, never rounded up,
 * so the figure shown is never more than the real one. Trailing zeros go.
 *
 * formatUnits(250000000000n, 6) === "250,000"
 * formatUnits("1234567", 6) === "1.234567"
 * formatUnits("1234567", 6, 2) === "1.23"
 */
export function formatUnits(
  raw: bigint | string,
  decimals: number,
  maxFractionDigits: number = decimals,
): string {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const base = BigInt(10) ** BigInt(decimals);

  const whole = (abs / base).toLocaleString("en-US");
  const fraction = (abs % base)
    .toString()
    .padStart(decimals, "0")
    .slice(0, Math.max(0, maxFractionDigits))
    .replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Parses a typed decimal amount ("1,250.5") into base units, or null if it
 * isn't a valid non-negative amount with at most `decimals` places.
 */
export function parseUnits(text: string, decimals: number): bigint | null {
  const clean = text.replace(/[,\s]/g, "");
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || clean === "" || clean === ".") return null;
  const [, whole = "", fraction = ""] = match;
  if (fraction.length > decimals) return null;
  return BigInt((whole || "0") + fraction.padEnd(decimals, "0"));
}

/** Shortens an address for display: "7xKp…3fQa". */
export function shortAddress(address: string, chars = 4): string {
  return address.length <= chars * 2 + 1
    ? address
    : `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

const two = (n: number) => n.toString().padStart(2, "0");

/**
 * Formats a number of seconds as a countdown: "04:12:09", or "2d 04:12:09"
 * once it is a day or more. Negative values count as zero.
 */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const clock = `${two(Math.floor((s % 86400) / 3600))}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

/** Formats a unix time (seconds) as a short local date and time. */
export function formatDateTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}
