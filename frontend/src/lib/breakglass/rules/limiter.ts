/**
 * Outflow limiter math, ported from programs/breakglass/src/limiter.rs and
 * clients/ts/src/limiter.ts on the backend branch. The window is 12 buckets
 * of width ceil(windowSecs / 11): it may over-count by up to one bucket,
 * never under.
 *
 * The functions that change a limiter (roll, record, evaluate) mutate it in
 * place, like the program does to its account; the mock calls them on its
 * own copy. The read helpers never mutate, so screens can use them directly.
 */
import type { FlowLimiter } from "../accounts.ts";
import { WINDOW_BUCKETS } from "../accounts.ts";
import { BPS_DENOMINATOR } from "../constants.ts";
import type { U64, UnixSeconds } from "../primitives.ts";

/** Bucket width in seconds: ceil(windowSecs / 11). */
export function bucketWidth(limiter: Pick<FlowLimiter, "windowSecs">): number {
  const n = WINDOW_BUCKETS - 1;
  return Math.floor((limiter.windowSecs + n - 1) / n);
}

const epochOf = (limiter: FlowLimiter, t: UnixSeconds) =>
  Math.floor(t / bucketWidth(limiter));

const indexOf = (epoch: number) =>
  ((epoch % WINDOW_BUCKETS) + WINDOW_BUCKETS) % WINDOW_BUCKETS;

/** `bps` of `balance`, rounded down. */
export function bpsOf(balance: U64, bps: number): U64 {
  return (balance * BigInt(bps)) / BPS_DENOMINATOR;
}

/** min(capAbsolute, capBpsOfVault × balance); capAbsolute when bps is 0. */
export function effectiveCap(limiter: FlowLimiter, vaultBalance: U64): U64 {
  if (limiter.capBpsOfVault === 0) return limiter.capAbsolute;
  const byBalance = bpsOf(vaultBalance, limiter.capBpsOfVault);
  return byBalance < limiter.capAbsolute ? byBalance : limiter.capAbsolute;
}

/** Withdrawals at or above this are held for size. */
export function effectiveThreshold(
  limiter: FlowLimiter,
  vaultBalance: U64,
): U64 {
  if (limiter.largeThresholdBps === 0) return limiter.largeThreshold;
  const byBalance = bpsOf(vaultBalance, limiter.largeThresholdBps);
  return byBalance < limiter.largeThreshold
    ? byBalance
    : limiter.largeThreshold;
}

/**
 * Outflow counted in the window at `now`, skipping buckets that have rolled
 * off but aren't zeroed yet. Doesn't mutate the limiter.
 */
export function windowUsage(limiter: FlowLimiter, now: UnixSeconds): U64 {
  const last = epochOf(limiter, limiter.bucketStart);
  const cur = epochOf(limiter, now);
  let sum = BigInt(0);
  for (let k = 0; k < WINDOW_BUCKETS; k++) {
    const epoch = last - k;
    if (epoch > cur - WINDOW_BUCKETS) sum += limiter.buckets[indexOf(epoch)];
  }
  return sum;
}

/**
 * Each bucket's outflow at `now`, oldest first, with expired buckets as 0:
 * what the window meter draws. Doesn't mutate the limiter.
 */
export function bucketsOldestFirst(
  limiter: FlowLimiter,
  now: UnixSeconds,
): U64[] {
  const cur = epochOf(limiter, now);
  const last = epochOf(limiter, limiter.bucketStart);
  const out: U64[] = [];
  for (let k = WINDOW_BUCKETS - 1; k >= 0; k--) {
    const epoch = cur - k;
    // A bucket counts only if it was written in its own epoch (epoch <= last)
    // and hasn't been overwritten by a later one (epoch > last - 12).
    const live = epoch <= last && epoch > last - WINDOW_BUCKETS;
    out.push(live ? limiter.buckets[indexOf(epoch)] : BigInt(0));
  }
  return out;
}

/** Zero buckets that left the window and move bucketStart to `now`'s bucket. */
export function roll(limiter: FlowLimiter, now: UnixSeconds): void {
  const cur = epochOf(limiter, now);
  const last = epochOf(limiter, limiter.bucketStart);
  if (cur <= last) return;
  if (cur - last >= WINDOW_BUCKETS) {
    limiter.buckets = limiter.buckets.map(() => BigInt(0));
  } else {
    for (let e = last + 1; e <= cur; e++)
      limiter.buckets[indexOf(e)] = BigInt(0);
  }
  limiter.bucketStart = cur * bucketWidth(limiter);
}

/** Sum of the buckets (call roll first). */
export function windowTotal(limiter: FlowLimiter): U64 {
  return limiter.buckets.reduce((sum, b) => sum + b, BigInt(0));
}

/** Count `amount` in the current bucket (call roll first). */
export function record(limiter: FlowLimiter, amount: U64): void {
  const i = indexOf(epochOf(limiter, limiter.bucketStart));
  limiter.buckets[i] += amount;
}

export type Verdict =
  | { kind: "allow"; windowTotal: U64; windowCap: U64 }
  | { kind: "holdLarge" }
  | { kind: "holdBreach"; windowTotal: U64; windowCap: U64 }
  | { kind: "holdScreen" };

/**
 * The outflow decision (the pause check comes first, in the caller).
 * Order: large threshold, then the window cap, then screening. Claims skip
 * the threshold and screening but still count against the window.
 */
export function evaluate(
  limiter: FlowLimiter,
  amount: U64,
  vaultBalance: U64,
  now: UnixSeconds,
  isClaim: boolean,
): Verdict {
  roll(limiter, now);
  const total = windowTotal(limiter);
  const cap = effectiveCap(limiter, vaultBalance);
  if (!isClaim && amount >= effectiveThreshold(limiter, vaultBalance)) {
    return { kind: "holdLarge" };
  }
  if (total + amount > cap) {
    return { kind: "holdBreach", windowTotal: total, windowCap: cap };
  }
  if (!isClaim && amount > limiter.instantAllowance) {
    return { kind: "holdScreen" };
  }
  record(limiter, amount);
  return { kind: "allow", windowTotal: windowTotal(limiter), windowCap: cap };
}
