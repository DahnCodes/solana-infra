/**
 * Config-change rules, ported from programs/breakglass/src/config_logic.rs
 * on the backend branch (Phase 4). Loosening anything, or releasing funds,
 * waits out the timelock and can be vetoed; tightening a limiter applies at
 * once.
 */
import type {
  ConfigAction,
  FlowLimiter,
  LimiterParams,
  PausePolicy,
  PendingConfig,
  ProtocolConfig,
} from "../accounts.ts";
import { WINDOW_BUCKETS } from "../accounts.ts";
import { DEFAULTS, MAX_GUARDIANS } from "../constants.ts";
import { require } from "../errors.ts";
import type { Seconds, UnixSeconds } from "../primitives.ts";
import { bucketWidth, record, roll, windowTotal } from "./limiter.ts";

/** Pubkey::default(), the all-zero key. */
export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** validate_params in limiter.rs: the ranges every limiter must stay in. */
export function validateLimiterParams(p: LimiterParams): void {
  require(p.windowSecs >= WINDOW_BUCKETS &&
    p.capAbsolute > BigInt(0) &&
    p.capBpsOfVault <= 10_000 &&
    p.largeThresholdBps <= 10_000 &&
    p.holdSecs > 0 &&
    p.autoTripSecs > 0 &&
    p.screenSecs > 0, "InvalidLimiterConfig");
}

/** A bps limit where 0 means "off" (the loosest setting). */
function bpsAtLeastAsStrict(old: number, next: number): boolean {
  return next === old || (next !== 0 && (old === 0 || next <= old));
}

/**
 * True if every field of `next` is equal to or stricter than `old`: lower
 * caps, thresholds and instant allowance; longer window, holds, auto-trips
 * and screening; a bps limit can be added or lowered, never removed.
 */
export function isTightening(old: LimiterParams, next: LimiterParams): boolean {
  return (
    next.windowSecs >= old.windowSecs &&
    next.capAbsolute <= old.capAbsolute &&
    bpsAtLeastAsStrict(old.capBpsOfVault, next.capBpsOfVault) &&
    next.largeThreshold <= old.largeThreshold &&
    bpsAtLeastAsStrict(old.largeThresholdBps, next.largeThresholdBps) &&
    next.holdSecs >= old.holdSecs &&
    next.autoTripSecs >= old.autoTripSecs &&
    next.instantAllowance <= old.instantAllowance &&
    next.screenSecs >= old.screenSecs
  );
}

/**
 * Apply new settings. If the window length changes, the bucket width does
 * too, so the current window total is folded into the newest bucket: it
 * may over-count for one window, but never under-counts.
 */
export function applyParams(
  l: FlowLimiter,
  p: LimiterParams,
  now: UnixSeconds,
): void {
  if (p.windowSecs !== l.windowSecs) {
    roll(l, now);
    const total = windowTotal(l);
    l.windowSecs = p.windowSecs;
    l.buckets = l.buckets.map(() => BigInt(0));
    const width = bucketWidth(l);
    l.bucketStart = now - (((now % width) + width) % width);
    record(l, total);
  }
  l.capAbsolute = p.capAbsolute;
  l.capBpsOfVault = p.capBpsOfVault;
  l.largeThreshold = p.largeThreshold;
  l.largeThresholdBps = p.largeThresholdBps;
  l.holdSecs = p.holdSecs;
  l.autoTripSecs = p.autoTripSecs;
  l.instantAllowance = p.instantAllowance;
  l.screenSecs = p.screenSecs;
}

export function validatePolicy(
  policy: PausePolicy,
  timelockSecs: Seconds,
): void {
  require(policy.maxGuardianPauseSecs > 0 &&
    policy.cooldownSecs >= 0 &&
    policy.budgetSecsPerPeriod > 0 &&
    policy.budgetPeriodSecs > 0 &&
    policy.autoTripSecs > 0, "InvalidPolicy");
  require(timelockSecs >= DEFAULTS.minTimelockSecs &&
    timelockSecs <= DEFAULTS.maxTimelockSecs, "InvalidTimelock");
}

/** Checks run at propose time and again at execute time. */
export function validateAction(
  config: ProtocolConfig,
  action: ConfigAction,
): void {
  switch (action.kind) {
    case "raiseLimits":
      return validateLimiterParams(action.params);
    case "addGuardian":
      require(action.guardian !== DEFAULT_PUBKEY, "WrongChangeAccounts");
      require(!config.guardians.includes(action.guardian), "DuplicateGuardian");
      require(config.guardians.length < MAX_GUARDIANS, "TooManyGuardians");
      return;
    case "setAdmin":
      require(action.admin !== DEFAULT_PUBKEY, "WrongChangeAccounts");
      return;
    case "releaseHeld":
      return;
    case "changePolicy":
      return validatePolicy(action.policy, action.timelockSecs);
  }
}

/** Whether a change can run at `now`. Order: closed, vetoed, timelock. */
export function requireExecutable(
  change: PendingConfig,
  now: UnixSeconds,
): void {
  require(!change.executed && !change.cancelled, "ChangeClosed");
  require(!change.vetoed, "Vetoed");
  require(now >= change.executableAt, "TimelockActive");
}
