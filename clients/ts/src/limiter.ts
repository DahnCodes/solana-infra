// Read a fetched FlowLimiter the way the program does (programs/breakglass/src/limiter.rs).

type Num = { toString(): string } | number | bigint;
const big = (n: Num) => BigInt(n.toString());

/** Shape of a FlowLimiter as Anchor decodes it (BN fields). */
export interface FlowLimiterLike {
  windowSecs: Num;
  capAbsolute: Num;
  capBpsOfVault: number;
  buckets: Num[];
  bucketStart: Num;
  largeThreshold: Num;
  largeThresholdBps: number;
}

const BUCKETS = 12n;
const BPS = 10_000n;

/** Bucket width in seconds: ceil(windowSecs / 11). */
export function bucketWidth(l: FlowLimiterLike): bigint {
  const w = big(l.windowSecs);
  return (w + BUCKETS - 2n) / (BUCKETS - 1n);
}

const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : -((-a + b - 1n) / b));
const mod = (a: bigint, b: bigint) => ((a % b) + b) % b;

/**
 * Outflow counted in the window at unix time `now`: the sum of buckets that
 * haven't rolled off yet. The stored `buckets` can include expired ones until
 * the next write; this skips them, exactly like the program's `roll`.
 */
export function windowUsage(l: FlowLimiterLike, now: Num): bigint {
  const width = bucketWidth(l);
  const last = floorDiv(big(l.bucketStart), width);
  const cur = floorDiv(big(now), width);
  let sum = 0n;
  for (let k = 0n; k < BUCKETS; k++) {
    const epoch = last - k;
    if (epoch > cur - BUCKETS) sum += big(l.buckets[Number(mod(epoch, BUCKETS))]);
  }
  return sum;
}

/** min(capAbsolute, capBpsOfVault x vaultBalance / 10000); capAbsolute when bps is 0. */
export function effectiveCap(l: FlowLimiterLike, vaultBalance: Num): bigint {
  const abs = big(l.capAbsolute);
  if (l.capBpsOfVault === 0) return abs;
  const byBalance = (big(vaultBalance) * BigInt(l.capBpsOfVault)) / BPS;
  return byBalance < abs ? byBalance : abs;
}

/** Withdrawals at or above this are held for size. */
export function effectiveThreshold(l: FlowLimiterLike, vaultBalance: Num): bigint {
  const abs = big(l.largeThreshold);
  if (l.largeThresholdBps === 0) return abs;
  const byBalance = (big(vaultBalance) * BigInt(l.largeThresholdBps)) / BPS;
  return byBalance < abs ? byBalance : abs;
}
