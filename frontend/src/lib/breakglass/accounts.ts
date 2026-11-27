/**
 * Breakglass program accounts (docs/FRONTEND.md section 3), plus the
 * protected test_vault's Position. All accounts are owned by the Breakglass
 * program; the seeds are noted on each.
 */
import type {
  Address,
  Bps,
  ScopeId,
  ScopeMask,
  Seconds,
  U64,
  UnixSeconds,
} from "./primitives";

// Enums --------------------------------------------------------------------

/** Who paused a scope. Only the admin can lift an auto-trip or admin pause. */
export type PauseKind = "guardian" | "autoTrip" | "admin";

/** Where a held withdrawal stands. */
export type HoldStatus =
  "queued" | "frozen" | "released" | "rejected" | "claimed";

/** Why a withdrawal was held: its size, a cap breach, or zero-loss screening. */
export type HoldKind = "large" | "limit" | "screen";

/** The gate's answer to a withdrawal. Deny arrives as a ScopePaused error. */
export type Decision = "allow" | "hold" | "deny";

// ProtocolConfig -------------------------------------------------------------

/** Limits on guardian pauses, set per protocol. */
export type PausePolicy = {
  /** Longest single guardian pause (default 24h). */
  maxGuardianPauseSecs: Seconds;
  /** Renewals per guardian pause (default 2). */
  maxRenewals: number;
  /** Wait after a guardian pause ends before the next (default 6h). */
  cooldownSecs: Seconds;
  /** Guardian pause seconds allowed per period (default 96h). */
  budgetSecsPerPeriod: Seconds;
  /** Length of a budget period (default 30 days). */
  budgetPeriodSecs: Seconds;
  /** How long an auto-trip pauses a scope (default 1h). */
  autoTripSecs: Seconds;
};

/** One registered protocol. Seeds: ["config", protectedProgram]. */
export type ProtocolConfig = {
  version: number;
  bump: number;
  protectedProgram: Address;
  /** Often a Squads vault PDA. */
  admin: Address;
  /** At most 5. */
  guardians: Address[];
  /** Scopes that can never be paused ("always open"). */
  unpausableMask: ScopeMask;
  policy: PausePolicy;
  /** Delay on loosening changes (default 48h). */
  timelockSecs: Seconds;
  /** Id the next PendingConfig will get. */
  nextChangeId: U64;
};

// PauseState -------------------------------------------------------------------

/**
 * One pause on one scope. A scope can have several entries at once (one per
 * scope, kind and pausedBy). Expiry is lazy: an entry counts only while
 * pausedUntil > now, and the scope reopens when the last one ends.
 */
export type ScopePause = {
  scope: ScopeId;
  pausedUntil: UnixSeconds;
  pausedBy: Address;
  kind: PauseKind;
  renewals: number;
  /** Free-form reason code (u16). Auto-trips use 1. */
  reason: number;
};

/** The pauses of one protocol. Seeds: ["pause", config]. */
export type PauseState = {
  bump: number;
  config: Address;
  /** At most 64 entries, including expired ones not yet cleaned up. */
  active: ScopePause[];
};

// GuardianLedger ---------------------------------------------------------------

/**
 * A guardian's pause budget and cooldown. Seeds: ["gledger", config, guardian].
 * Created on the guardian's first pause, so a missing ledger means full
 * budget and no cooldown.
 */
export type GuardianLedger = {
  bump: number;
  config: Address;
  guardian: Address;
  periodStart: UnixSeconds;
  pauseSecsUsed: Seconds;
  /** Scheduled end of its latest pause; the cooldown runs from here. */
  lastPauseEnd: UnixSeconds;
};

// FlowLimiter ------------------------------------------------------------------

/** Number of sub-buckets in a limiter's rolling window. */
export const WINDOW_BUCKETS = 12;

/**
 * The outflow limiter for one token mint. Seeds: ["flow", config, mint].
 * Effective cap = min(capAbsolute, capBpsOfVault × vault balance / 10,000).
 */
export type FlowLimiter = {
  bump: number;
  config: Address;
  mint: Address;
  /** The protocol's vault token account for this mint. */
  vault: Address;
  /** The outflow scope it gates and auto-trips. */
  scope: ScopeId;
  windowSecs: Seconds;
  capAbsolute: U64;
  /** 0 = no balance-based cap. */
  capBpsOfVault: Bps;
  /** Outflow per sub-bucket, newest at bucketStart (12 entries). */
  buckets: U64[];
  bucketStart: UnixSeconds;
  /** Withdrawals at or above the effective threshold are held. */
  largeThreshold: U64;
  /** 0 = absolute threshold only. */
  largeThresholdBps: Bps;
  holdSecs: Seconds;
  autoTripSecs: Seconds;
  /** 0 = screen every withdrawal; u64 max = never screen. */
  instantAllowance: U64;
  screenSecs: Seconds;
};

// PendingWithdrawal ------------------------------------------------------------

/**
 * A held withdrawal. Seeds: ["hold", config, owner, nonce]. Claimable when
 * its scope isn't paused and either it is queued with now >= releaseAt, or
 * it is released. Stays on chain after it resolves.
 */
export type PendingWithdrawal = {
  bump: number;
  config: Address;
  owner: Address;
  mint: Address;
  amount: U64;
  nonce: U64;
  createdAt: UnixSeconds;
  releaseAt: UnixSeconds;
  status: HoldStatus;
  scope: ScopeId;
  kind: HoldKind;
};

// PendingConfig (planned, backend phase 4) -------------------------------------

/**
 * A loosening change waiting out the timelock. PROVISIONAL: FRONTEND.md
 * names these five actions for phase 4 but not their fields. The fields
 * below are our reading of the spec; replace them with the IDL's when
 * phase 4 lands (checkpoint A).
 */
export type ConfigAction =
  | {
      kind: "raiseLimits";
      mint: Address;
      capAbsolute: U64;
      capBpsOfVault: Bps;
      largeThreshold: U64;
      largeThresholdBps: Bps;
    }
  | { kind: "addGuardian"; guardian: Address }
  | { kind: "setAdmin"; admin: Address }
  | { kind: "releaseHeld"; hold: Address }
  | { kind: "changePolicy"; policy: PausePolicy };

/** Seeds: ["cfgchg", config, id]. Planned for backend phase 4. */
export type PendingConfig = {
  bump: number;
  config: Address;
  id: U64;
  action: ConfigAction;
  proposedAt: UnixSeconds;
  /** Anyone can execute it from this time on, unless vetoed. */
  executableAt: UnixSeconds;
  vetoed: boolean;
  executed: boolean;
};

// test_vault (the demo protected protocol) -------------------------------------

/**
 * A user's position in the test vault. `amount` can be withdrawn now; `held`
 * sits in queued or frozen holds and is still owed to the user.
 */
export type Position = {
  owner: Address;
  vault: Address;
  amount: U64;
  held: U64;
};
