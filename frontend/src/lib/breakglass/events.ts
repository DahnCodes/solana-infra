/**
 * Breakglass events (docs/FRONTEND.md section 6). Every state change emits
 * one, through emit_cpi!. Names are camelCase, as Anchor's TypeScript coder
 * reports them ("paused", not "Paused").
 */
import type {
  Address,
  ScopeId,
  ScopeMask,
  Signature,
  U64,
  UnixSeconds,
} from "./primitives";

/** `kind` on a Paused event: 0 guardian, 1 auto-trip, 2 admin. */
export type PauseKindCode = 0 | 1 | 2;

/** `outcome` on a HoldResolved event: 0 claimed, 1 released, 2 rejected. */
export type HoldOutcomeCode = 0 | 1 | 2;

export const PAUSE_KIND_BY_CODE = {
  0: "guardian",
  1: "autoTrip",
  2: "admin",
} as const satisfies Record<PauseKindCode, string>;

export const HOLD_OUTCOME_BY_CODE = {
  0: "claimed",
  1: "released",
  2: "rejected",
} as const satisfies Record<HoldOutcomeCode, string>;

/** Each event's fields, keyed by its camelCase name. */
export type EventDataByName = {
  /** Protocol registered. */
  configInitialized: {
    config: Address;
    protectedProgram: Address;
    admin: Address;
    guardians: Address[];
  };
  /** Scopes paused. pausedUntil is the latest end across the scopes. */
  paused: {
    config: Address;
    scopesMask: ScopeMask;
    pausedUntil: UnixSeconds;
    by: Address;
    kind: PauseKindCode;
    reason: number;
  };
  /** Pause extended. pausedUntil and renewals are the max across the scopes. */
  pauseRenewed: {
    config: Address;
    scopesMask: ScopeMask;
    pausedUntil: UnixSeconds;
    by: Address;
    renewals: number;
  };
  /** Pause lifted early; scopesMask holds only the scopes actually lifted. */
  unpaused: {
    config: Address;
    scopesMask: ScopeMask;
    by: Address;
  };
  /** Guardian removed by the admin. Its running pauses stay. */
  guardianRemoved: {
    config: Address;
    guardian: Address;
  };
  /** Funds left the vault. windowTotal includes amount. */
  outflowRecorded: {
    config: Address;
    mint: Address;
    owner: Address;
    amount: U64;
    windowTotal: U64;
    windowCap: U64;
  };
  /** Held for size (kind "large"). */
  largeWithdrawalQueued: {
    config: Address;
    hold: Address;
    mint: Address;
    owner: Address;
    amount: U64;
    releaseAt: UnixSeconds;
  };
  /** Held because it would cross the cap (kind "limit"). */
  limitHoldQueued: {
    config: Address;
    hold: Address;
    mint: Address;
    owner: Address;
    amount: U64;
    releaseAt: UnixSeconds;
  };
  /** Held for zero-loss screening (kind "screen"). */
  withdrawalScreenQueued: {
    config: Address;
    hold: Address;
    mint: Address;
    owner: Address;
    amount: U64;
    releaseAt: UnixSeconds;
  };
  /** Cap breached; the scope is auto-paused until pausedUntil. */
  limitTripped: {
    config: Address;
    mint: Address;
    scope: ScopeId;
    windowTotal: U64;
    windowCap: U64;
    pausedUntil: UnixSeconds;
  };
  /** A guardian (or the admin) froze a hold. */
  holdFrozen: {
    config: Address;
    hold: Address;
    by: Address;
  };
  /** A hold was claimed, released or rejected. */
  holdResolved: {
    config: Address;
    hold: Address;
    outcome: HoldOutcomeCode;
  };
  /** Timelocked change queued (backend phase 4). */
  configChangeProposed: {
    config: Address;
    change: Address;
    actionKind: number;
    executableAt: UnixSeconds;
  };
  /** Timelocked change executed (backend phase 4). */
  configChangeExecuted: {
    config: Address;
    change: Address;
  };
  /** Timelocked change vetoed by a guardian (backend phase 4). */
  configChangeVetoed: {
    config: Address;
    change: Address;
    by: Address;
  };
};

export type BreakglassEventName = keyof EventDataByName;

/** Any Breakglass event, narrowed by `name`. */
export type BreakglassEvent = {
  [N in BreakglassEventName]: { name: N; data: EventDataByName[N] };
}[BreakglassEventName];

/** An event with the transaction it came from, for the activity feed. */
export type BreakglassEventRecord = {
  event: BreakglassEvent;
  signature: Signature;
  slot: number;
  blockTime: UnixSeconds;
};
