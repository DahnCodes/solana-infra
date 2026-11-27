// Mirrors programs/breakglass/src/constants.rs. Keep the two in sync.

/** PDA seeds. */
export const SEEDS = {
  config: "config",
  pause: "pause",
  flow: "flow",
  hold: "hold",
  configChange: "cfgchg",
  guardianLedger: "gledger",
  /** Seed of the PDA a *protected program* signs with when it CPIs check_outflow. */
  gateSigner: "breakglass-gate",
} as const;

export const MAX_GUARDIANS = 5;
/** Max pause entries in PauseState (one per scope + kind + pauser). */
export const MAX_ACTIVE_PAUSES = 64;
/** Scope ids are 0..63 and are combined into a u64 bitmask. */
export const MAX_SCOPES = 64;

/**
 * Example scope ids used by test-vault. Each protocol maps its own
 * instructions to scope ids, so read the protocol's mapping for real labels.
 */
export const SCOPES = {
  DEPOSIT: 0,
  WITHDRAW: 1,
  BORROW: 2,
  REPAY: 3,
} as const;

/** Build a u64 scope mask (as bigint) from scope ids. */
export function scopeMask(...scopes: number[]): bigint {
  let mask = 0n;
  for (const s of scopes) {
    if (!Number.isInteger(s) || s < 0 || s >= MAX_SCOPES) {
      throw new RangeError(`scope ${s} out of range 0..${MAX_SCOPES - 1}`);
    }
    mask |= 1n << BigInt(s);
  }
  return mask;
}

/** Inverse of scopeMask: list the scope ids set in a u64 mask. */
export function scopesInMask(mask: bigint | number | string): number[] {
  const m = BigInt(mask);
  const out: number[] = [];
  for (let s = 0; s < MAX_SCOPES; s++) {
    if ((m >> BigInt(s)) & 1n) out.push(s);
  }
  return out;
}

/** Spec defaults, in seconds. On-chain values live in ProtocolConfig.policy and FlowLimiter. */
export const DEFAULTS = {
  maxGuardianPauseSecs: 24 * 3600,
  maxRenewals: 2,
  cooldownSecs: 6 * 3600,
  budgetSecsPerPeriod: 96 * 3600,
  budgetPeriodSecs: 30 * 24 * 3600,
  autoTripSecs: 3600,
  windowSecs: 3600,
  holdSecs: 6 * 3600,
  screenSecs: 120,
  timelockSecs: 48 * 3600,
  minTimelockSecs: 24 * 3600,
  maxTimelockSecs: 48 * 3600,
} as const;

/** `Paused.kind` event values. Account fields use the enum form instead ({ guardian: {} } etc.). */
export const PAUSE_KIND = { guardian: 0, autoTrip: 1, admin: 2 } as const;

/** HoldResolved.outcome values. */
export const HOLD_OUTCOME = { claimed: 0, released: 1, rejected: 2 } as const;
