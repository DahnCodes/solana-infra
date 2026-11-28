/**
 * Program constants, mirroring clients/ts/src/constants.ts and
 * programs/breakglass/src/constants.rs on the backend branch.
 */
import type { ScopeId, ScopeMask } from "./primitives.ts";

export const MAX_GUARDIANS = 5;
/** Max entries in PauseState.active (one per scope, kind and pauser). */
export const MAX_ACTIVE_PAUSES = 64;
/** Scope ids are 0 to 63. */
export const MAX_SCOPES = 64;
export const BPS_DENOMINATOR = BigInt(10_000);
export const U64_MAX = BigInt("18446744073709551615");
/** `reason` on a pause written by an auto-trip. */
export const AUTO_TRIP_REASON = 1;

/** The test vault's scopes. Each protocol names its own. */
export const TEST_VAULT_SCOPES = {
  deposit: 0,
  withdraw: 1,
  borrow: 2,
  repay: 3,
} as const;

/** Labels for the test vault's scopes; REPAY is unpausable. */
export const TEST_VAULT_SCOPE_LABELS: Record<ScopeId, string> = {
  0: "Deposits",
  1: "Withdrawals",
  2: "Borrows",
  3: "Repays",
};

/** Spec defaults, in seconds. */
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

/** A u64 scope mask from scope ids. */
export function scopeMask(...scopes: ScopeId[]): ScopeMask {
  let mask = BigInt(0);
  for (const s of scopes) {
    if (!Number.isInteger(s) || s < 0 || s >= MAX_SCOPES) {
      throw new RangeError(`Scope ${s} is outside 0 to ${MAX_SCOPES - 1}.`);
    }
    mask |= BigInt(1) << BigInt(s);
  }
  return mask;
}

/** The scope ids set in a mask, ascending. */
export function scopesInMask(mask: ScopeMask): ScopeId[] {
  const out: ScopeId[] = [];
  for (let s = 0; s < MAX_SCOPES; s++) {
    if ((mask >> BigInt(s)) & BigInt(1)) out.push(s);
  }
  return out;
}

/**
 * Code for each config action, as ConfigChangeProposed.actionKind carries
 * it (FRONTEND.md section 6, `ACTION_KIND`).
 */
export const CONFIG_ACTION_CODES = {
  raiseLimits: 0,
  addGuardian: 1,
  setAdmin: 2,
  releaseHeld: 3,
  changePolicy: 4,
} as const;
