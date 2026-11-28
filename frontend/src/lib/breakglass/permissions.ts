/**
 * Who may do what, with the reason when they may not, mirroring the
 * program's checks (docs/FRONTEND.md section 5 and the roles table). Screens
 * use these to show, disable or explain each action before anything is
 * signed; the program still has the final say.
 */
import type {
  PendingConfig,
  PendingWithdrawal,
  ProtocolConfig,
} from "./accounts.ts";
import type { Address, UnixSeconds } from "./primitives.ts";

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

// Timelocked changes -------------------------------------------------------------

export function canExecute(
  wallet: Address | null,
  change: PendingConfig,
  now: UnixSeconds,
): Permission {
  if (!wallet) return no(NO_WALLET);
  if (change.executed) return no("Already done.");
  if (change.vetoed) return no("Vetoed by the guardian.");
  if (now < change.executableAt) return no("Still in the timelock.");
  return yes;
}

export function canVeto(role: Role | null, change: PendingConfig): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "guardian") return no("Only a guardian can veto.");
  if (change.executed || change.vetoed) return no("This change is settled.");
  return yes;
}

export function canCancel(
  role: Role | null,
  change: PendingConfig,
): Permission {
  if (!role) return no(NO_WALLET);
  if (role !== "admin") return no("Only the admin can cancel its change.");
  if (change.executed) return no("Already done.");
  return yes;
}
