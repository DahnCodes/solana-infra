/**
 * Pause rules, ported from programs/breakglass/src/pause_logic.rs and
 * gate.rs on the backend branch. The apply* functions mutate the state and
 * ledger they are given, like the program does to its accounts, and throw a
 * RuleError when the program would reject the call.
 *
 * Model: PauseState.active holds one entry per (scope, kind, pausedBy). A
 * scope is paused while any of its entries has pausedUntil > now. Expired
 * entries are pruned on every write.
 */
import type {
  FlowLimiter,
  GuardianLedger,
  PauseKind,
  PausePolicy,
  PauseState,
  ProtocolConfig,
  ScopePause,
} from "../accounts.ts";
import {
  AUTO_TRIP_REASON,
  MAX_ACTIVE_PAUSES,
  scopeMask,
  scopesInMask,
} from "../constants.ts";
import { require, RuleError } from "../errors.ts";
import type {
  Address,
  ScopeId,
  ScopeMask,
  Seconds,
  UnixSeconds,
} from "../primitives.ts";

// Reading ----------------------------------------------------------------------

/** Entries still running at `now`. */
export function runningPauses(
  active: ScopePause[],
  now: UnixSeconds,
): ScopePause[] {
  return active.filter((p) => p.pausedUntil > now);
}

export function isScopePaused(
  active: ScopePause[],
  scope: ScopeId,
  now: UnixSeconds,
): boolean {
  return runningPauses(active, now).some((p) => p.scope === scope);
}

/** Bitmask of every scope paused at `now`. */
export function pausedMask(active: ScopePause[], now: UnixSeconds): ScopeMask {
  let mask = BigInt(0);
  for (const p of runningPauses(active, now)) mask |= scopeMask(p.scope);
  return mask;
}

/** When `scope` reopens (its latest running entry), or null if open. */
export function scopePausedUntil(
  active: ScopePause[],
  scope: ScopeId,
  now: UnixSeconds,
): UnixSeconds | null {
  let until: UnixSeconds | null = null;
  for (const p of runningPauses(active, now)) {
    if (p.scope === scope && (until === null || p.pausedUntil > until)) {
      until = p.pausedUntil;
    }
  }
  return until;
}

// Roles ------------------------------------------------------------------------

export type Role = "admin" | "guardian";

/** Admin takes precedence if a key is both. Anyone else is Unauthorized. */
export function roleOf(config: ProtocolConfig, key: Address): Role {
  if (key === config.admin) return "admin";
  if (config.guardians.includes(key)) return "guardian";
  throw new RuleError("Unauthorized");
}

// Guardian ledger --------------------------------------------------------------

/** A ledger as the program creates it on first use. */
export function newLedger(
  config: Address,
  guardian: Address,
  now: UnixSeconds,
): GuardianLedger {
  return {
    bump: 255,
    config,
    guardian,
    periodStart: now,
    pauseSecsUsed: 0,
    lastPauseEnd: 0,
  };
}

/** Start a fresh budget period once the current one is over. */
export function rollPeriod(
  ledger: GuardianLedger,
  policy: PausePolicy,
  now: UnixSeconds,
): void {
  if (now >= ledger.periodStart + policy.budgetPeriodSecs) {
    ledger.periodStart = now;
    ledger.pauseSecsUsed = 0;
  }
}

/** When the guardian may pause again. */
export function cooldownEnds(
  ledger: GuardianLedger,
  policy: PausePolicy,
): UnixSeconds {
  return ledger.lastPauseEnd + policy.cooldownSecs;
}

/** Budget left at `now`, counting a period that has already rolled over. */
export function budgetLeft(
  ledger: GuardianLedger | null,
  policy: PausePolicy,
  now: UnixSeconds,
): Seconds {
  if (!ledger || now >= ledger.periodStart + policy.budgetPeriodSecs) {
    return policy.budgetSecsPerPeriod;
  }
  return Math.max(0, policy.budgetSecsPerPeriod - ledger.pauseSecsUsed);
}

function charge(ledger: GuardianLedger, policy: PausePolicy, secs: Seconds) {
  const used = ledger.pauseSecsUsed + secs;
  require(used <= policy.budgetSecsPerPeriod, "PauseBudgetExhausted");
  ledger.pauseSecsUsed = used;
}

// Writing ----------------------------------------------------------------------

function pruneExpired(state: PauseState, now: UnixSeconds) {
  state.active = state.active.filter((p) => p.pausedUntil > now);
}

/** Add a pause, or extend the same party's entry. Never shortens. */
function upsert(
  state: PauseState,
  entry: Omit<ScopePause, "renewals"> & { renewals: number },
): UnixSeconds {
  const existing = state.active.find(
    (p) =>
      p.scope === entry.scope &&
      p.kind === entry.kind &&
      p.pausedBy === entry.pausedBy,
  );
  if (existing) {
    existing.pausedUntil = Math.max(existing.pausedUntil, entry.pausedUntil);
    existing.renewals = Math.max(existing.renewals, entry.renewals);
    return existing.pausedUntil;
  }
  require(state.active.length < MAX_ACTIVE_PAUSES, "TooManyActivePauses");
  state.active.push({ ...entry });
  return entry.pausedUntil;
}

/** pause(scopes, duration, reason). The ledger is charged for guardians only. */
export function applyPause(
  state: PauseState,
  ledger: GuardianLedger,
  config: ProtocolConfig,
  by: Address,
  mask: ScopeMask,
  duration: Seconds,
  reason: number,
  now: UnixSeconds,
): { pausedUntil: UnixSeconds; kind: PauseKind } {
  const role = roleOf(config, by);
  require(mask !== BigInt(0), "InvalidScope");
  require((mask & config.unpausableMask) === BigInt(0), "ScopeUnpausable");
  require(duration > 0, "InvalidDuration");
  const until = now + duration;
  const policy = config.policy;

  let kind: PauseKind = "admin";
  if (role === "guardian") {
    require(duration <= policy.maxGuardianPauseSecs, "PauseTooLong");
    rollPeriod(ledger, policy, now);
    require(now >= cooldownEnds(ledger, policy), "GuardianCooldown");
    charge(ledger, policy, duration);
    ledger.lastPauseEnd = Math.max(ledger.lastPauseEnd, until);
    kind = "guardian";
  }

  pruneExpired(state, now);
  let pausedUntil = until;
  for (const scope of scopesInMask(mask)) {
    pausedUntil = Math.max(
      pausedUntil,
      upsert(state, {
        scope,
        kind,
        pausedBy: by,
        pausedUntil: until,
        reason,
        renewals: 0,
      }),
    );
  }
  return { pausedUntil, kind };
}

/**
 * renew_pause(scopes): extends by policy.maxGuardianPauseSecs.
 * Guardian: only its own running pauses, up to maxRenewals each, charged.
 * Admin: any running pause, no cap, recorded as an admin entry.
 */
export function applyRenew(
  state: PauseState,
  ledger: GuardianLedger,
  config: ProtocolConfig,
  by: Address,
  mask: ScopeMask,
  now: UnixSeconds,
): { pausedUntil: UnixSeconds; renewals: number } {
  const role = roleOf(config, by);
  require(mask !== BigInt(0), "InvalidScope");
  const policy = config.policy;
  const ext = policy.maxGuardianPauseSecs;
  pruneExpired(state, now);
  const out = { pausedUntil: 0, renewals: 0 };
  const forScope = (scope: ScopeId) =>
    state.active.filter((p) => p.scope === scope);

  if (role === "guardian") {
    const own = (p: ScopePause) => p.kind === "guardian" && p.pausedBy === by;
    for (const scope of scopesInMask(mask)) {
      const mine = forScope(scope).find(own);
      if (mine) require(mine.renewals < policy.maxRenewals, "RenewCapReached");
      else if (forScope(scope).length > 0) throw new RuleError("Unauthorized");
      else throw new RuleError("ScopeNotPaused");
    }
    rollPeriod(ledger, policy, now);
    charge(ledger, policy, ext);
    for (const p of state.active) {
      if ((mask & scopeMask(p.scope)) !== BigInt(0) && own(p)) {
        p.pausedUntil += ext;
        p.renewals += 1;
        out.pausedUntil = Math.max(out.pausedUntil, p.pausedUntil);
        out.renewals = Math.max(out.renewals, p.renewals);
      }
    }
    ledger.lastPauseEnd = Math.max(ledger.lastPauseEnd, out.pausedUntil);
    return out;
  }

  for (const scope of scopesInMask(mask)) {
    const entries = forScope(scope);
    if (entries.length === 0) throw new RuleError("ScopeNotPaused");
    const longest = entries.reduce((a, b) =>
      b.pausedUntil > a.pausedUntil ? b : a,
    );
    const renewals = Math.max(...entries.map((p) => p.renewals)) + 1;
    const until = upsert(state, {
      scope,
      kind: "admin",
      pausedBy: by,
      pausedUntil: longest.pausedUntil + ext,
      reason: longest.reason,
      renewals,
    });
    out.pausedUntil = Math.max(out.pausedUntil, until);
    out.renewals = Math.max(out.renewals, renewals);
  }
  return out;
}

/**
 * unpause(scopes). Returns the mask actually lifted.
 * Admin lifts everything; a guardian only scopes whose running pauses are
 * all its own guardian pauses. Nothing lifted fails with ScopeNotPaused.
 */
export function applyUnpause(
  state: PauseState,
  config: ProtocolConfig,
  by: Address,
  mask: ScopeMask,
  now: UnixSeconds,
): ScopeMask {
  const role = roleOf(config, by);
  require(mask !== BigInt(0), "InvalidScope");
  pruneExpired(state, now);

  if (role === "guardian") {
    for (const scope of scopesInMask(mask)) {
      const allOwn = state.active
        .filter((p) => p.scope === scope)
        .every((p) => p.kind === "guardian" && p.pausedBy === by);
      require(allOwn, "Unauthorized");
    }
  }

  let lifted = BigInt(0);
  state.active = state.active.filter((p) => {
    const hit = (mask & scopeMask(p.scope)) !== BigInt(0);
    if (hit) lifted |= scopeMask(p.scope);
    return !hit;
  });
  require(lifted !== BigInt(0), "ScopeNotPaused");
  return lifted;
}

/** Auto-trip the limiter's scope for autoTripSecs. Only the admin can lift it. */
export function autoTrip(
  state: PauseState,
  limiterAddress: Address,
  limiter: FlowLimiter,
  now: UnixSeconds,
): UnixSeconds {
  pruneExpired(state, now);
  return upsert(state, {
    scope: limiter.scope,
    kind: "autoTrip",
    pausedBy: limiterAddress,
    pausedUntil: now + limiter.autoTripSecs,
    reason: AUTO_TRIP_REASON,
    renewals: 0,
  });
}
