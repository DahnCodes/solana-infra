/**
 * Who may do what, with the reason when they may not, mirroring the
 * program's checks (docs/FRONTEND.md section 5 and the roles table). Screens
 * use these to show, disable or explain each action before anything is
 * signed; the program still has the final say.
 */
import type {
  GuardianLedger,
  PauseState,
  PendingConfig,
  PendingWithdrawal,
  ProtocolConfig,
} from "./accounts.ts";
import { changeState } from "./accounts.ts";
import { RuleError } from "./errors.ts";
import { BREAKGLASS_MESSAGES } from "./messages.ts";
import type { Address, ScopeMask, Seconds, UnixSeconds } from "./primitives.ts";
import {
  applyPause,
  applyRenew,
  applyUnpause,
  newLedger,
} from "./rules/pauses.ts";

export type Role = "admin" | "guardian" | "user";

/** What the wallet is to this protocol. A wallet that is both acts as admin. */
export function roleOf(
  config: ProtocolConfig | undefined,
  wallet: Address | null,
): Role | null {
  if (!config || !wallet) return null;
  if (wallet === config.admin) return "admin";
  if (config.guardians.includes(wallet)) return "guardian";
  return "user";
}

export type Permission = { allowed: true } | { allowed: false; reason: string };

const yes: Permission = { allowed: true };
const no = (reason: string): Permission => ({ allowed: false, reason });

const NO_WALLET = "Connect a wallet first.";

// Holds ------------------------------------------------------------------------

export function canFreeze(
  role: Role | null,
  hold: PendingWithdrawal,
): Permission {
  if (!role) return no(NO_WALLET);
  if (role === "user")
    return no("Only a guardian or the admin can freeze a hold.");
  if (hold.status !== "queued") return no("Only a waiting hold can be frozen.");
  return yes;
}

export function canReject(
  role: Role | null,
  hold: PendingWithdrawal,
): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can reject a hold.");
  if (!["queued", "frozen", "released"].includes(hold.status)) {
    return no("This hold is already settled.");
  }
  return yes;
}

/** Releasing goes through the timelock: the admin proposes it. */
export function canProposeRelease(
  role: Role | null,
  hold: PendingWithdrawal,
  pendingRelease: PendingConfig | null,
): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can release a frozen hold.");
  if (hold.status !== "frozen")
    return no("Only a frozen hold needs releasing.");
  if (pendingRelease)
    return no("A release is already waiting out the timelock.");
  return yes;
}

export function canClaim(
  wallet: Address | null,
  hold: PendingWithdrawal,
  now: UnixSeconds,
  scopePaused: boolean,
): Permission {
  if (!wallet) return no(NO_WALLET);
  if (wallet !== hold.owner) return no("Only the owner can claim it.");
  if (hold.status === "frozen")
    return no("Frozen by the guardian: it can't be claimed.");
  if (hold.status !== "queued" && hold.status !== "released") {
    return no("This hold is already settled.");
  }
  if (hold.status === "queued" && now < hold.releaseAt) {
    return no("Still in its hold.");
  }
  if (scopePaused) return no("Withdrawals are paused, so claims wait too.");
  return yes;
}

// Pauses -----------------------------------------------------------------------------
//
// These run the program's own pause rules on copies of the accounts, so a
// button says no for exactly the reasons the program would.

type PauseContext = {
  config: ProtocolConfig;
  configAddress: Address;
  state: PauseState;
  /** The signer's ledger, or null if it has never paused. */
  ledger: GuardianLedger | null;
  wallet: Address | null;
  now: UnixSeconds;
};

function simulate(
  ctx: PauseContext,
  run: (state: PauseState, ledger: GuardianLedger) => void,
): Permission {
  if (!ctx.wallet) return no(NO_WALLET);
  const state = structuredClone(ctx.state);
  const ledger = ctx.ledger
    ? structuredClone(ctx.ledger)
    : newLedger(ctx.configAddress, ctx.wallet, ctx.now);
  try {
    run(state, ledger);
    return yes;
  } catch (error) {
    if (error instanceof RuleError) {
      return no(BREAKGLASS_MESSAGES[error.errorName]);
    }
    throw error;
  }
}

export function canPause(
  ctx: PauseContext,
  scopes: ScopeMask,
  duration: Seconds,
): Permission {
  return simulate(ctx, (state, ledger) =>
    applyPause(
      state,
      ledger,
      ctx.config,
      ctx.wallet!,
      scopes,
      duration,
      0,
      ctx.now,
    ),
  );
}

export function canRenew(ctx: PauseContext, scopes: ScopeMask): Permission {
  return simulate(ctx, (state, ledger) =>
    applyRenew(state, ledger, ctx.config, ctx.wallet!, scopes, ctx.now),
  );
}

export function canUnpause(ctx: PauseContext, scopes: ScopeMask): Permission {
  return simulate(ctx, (state) =>
    applyUnpause(state, ctx.config, ctx.wallet!, scopes, ctx.now),
  );
}

// Config -----------------------------------------------------------------------------

export function canRemoveGuardian(role: Role | null): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can remove a guardian.");
  return yes;
}

export function canPropose(role: Role | null): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can propose changes.");
  return yes;
}

// Limits ---------------------------------------------------------------------------

/** Tightening applies at once; only the admin may do it. */
export function canTighten(role: Role | null): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can tighten limits.");
  return yes;
}

// Timelocked changes -------------------------------------------------------------

export function canExecute(
  wallet: Address | null,
  change: PendingConfig,
  now: UnixSeconds,
): Permission {
  if (!wallet) return no(NO_WALLET);
  switch (changeState(change, now)) {
    case "cancelled":
      return no("Cancelled by the admin.");
    case "executed":
      return no("Already done.");
    case "vetoed":
      return no("Vetoed by the guardian.");
    case "waiting":
      return no("Still in the timelock.");
    case "ready":
      return yes;
  }
}

/** A guardian can veto until the change runs, even after the timelock. */
export function canVeto(role: Role | null, change: PendingConfig): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "guardian") return no("Only a guardian can veto.");
  if (change.executed || change.cancelled) return no("This change is settled.");
  if (change.vetoed) return no("Already vetoed.");
  return yes;
}

/** The admin can cancel until the change runs, also after a veto. */
export function canCancel(
  role: Role | null,
  change: PendingConfig,
): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can cancel its change.");
  if (change.executed) return no("Already done.");
  if (change.cancelled) return no("Already cancelled.");
  return yes;
}
