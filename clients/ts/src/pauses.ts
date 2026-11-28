// Helpers for reading a fetched PauseState. Expiry is lazy on-chain: an entry
// past its pausedUntil stays in `active` until the next write, but no longer counts.

/** Shape of one `PauseState.active` entry as Anchor decodes it. */
export interface ScopePauseLike {
  scope: number;
  pausedUntil: { toString(): string } | number | bigint;
  pausedBy: { toBase58(): string };
  kind: { guardian?: object; autoTrip?: object; admin?: object };
  renewals: number;
  reason: number;
}

const untilOf = (p: ScopePauseLike) => BigInt(p.pausedUntil.toString());

/** Entries still running at unix time `now` (use the cluster clock if precision matters). */
export function runningPauses<T extends ScopePauseLike>(active: T[], now: number | bigint): T[] {
  const t = BigInt(now);
  return active.filter((p) => untilOf(p) > t);
}

/** True if `scope` is paused at `now`. Matches the program's `PauseState::is_paused`. */
export function isScopePaused(active: ScopePauseLike[], scope: number, now: number | bigint): boolean {
  return runningPauses(active, now).some((p) => p.scope === scope);
}

/** Bitmask of every scope paused at `now`. */
export function pausedMask(active: ScopePauseLike[], now: number | bigint): bigint {
  let mask = 0n;
  for (const p of runningPauses(active, now)) mask |= 1n << BigInt(p.scope);
  return mask;
}

/** When `scope` reopens (latest running entry), or null if it isn't paused. */
export function scopePausedUntil(active: ScopePauseLike[], scope: number, now: number | bigint): bigint | null {
  let until: bigint | null = null;
  for (const p of runningPauses(active, now)) {
    if (p.scope === scope && (until === null || untilOf(p) > until)) until = untilOf(p);
  }
  return until;
}

/** Name of an entry's kind: "guardian" | "autoTrip" | "admin". */
export function pauseKindName(p: ScopePauseLike): "guardian" | "autoTrip" | "admin" {
  if (p.kind.guardian) return "guardian";
  if (p.kind.autoTrip) return "autoTrip";
  return "admin";
}
