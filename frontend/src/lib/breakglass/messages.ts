/**
 * What to tell people when a write fails, by error name. Breakglass errors
 * use docs/FRONTEND.md section 8's wording where it gives one; the rest are
 * the protocol's and the token program's errors the demo can hit. Step 5.4
 * checks this list against the final IDL at checkpoint A.
 */
import type { BreakglassErrorName } from "./errors.ts";

export const BREAKGLASS_MESSAGES: Record<BreakglassErrorName, string> = {
  ScopePaused: "This action is temporarily paused for safety.",
  InvalidScope: "Pick at least one scope.",
  ScopeUnpausable: "This action can't be paused.",
  Unauthorized: "Your wallet isn't allowed to do this.",
  TooManyGuardians: "A protocol can have at most 5 guardians.",
  PauseTooLong: "Pause is longer than the guardian maximum.",
  RenewCapReached: "Renewal limit reached. Only the admin can extend.",
  GuardianCooldown: "Guardian is cooling down.",
  PauseBudgetExhausted: "Guardian has used its pause budget for this period.",
  TooManyActivePauses: "Too many pauses are running. Lift one first.",
  HoldNotReleased: "Not unlocked yet.",
  HoldFrozen: "Under review by the guardian.",
  HoldInvalidState: "This hold has already moved on.",
  InvalidCaller: "Only the protocol can call this.",
  TimelockActive: "Change is queued and still in the timelock.",
  InvalidTimelock: "The timelock must be between 24 and 48 hours.",
  Vetoed: "Change was vetoed by the guardian.",
  InvariantViolated:
    "Transaction blocked by a safety check. Don't retry; the protocol needs a look.",
  MathOverflow: "A number was too large.",
  NotExecutable: "This change can't be executed.",
  ScopeNotPaused: "Nothing to renew or lift: that scope isn't paused.",
  InvalidDuration: "Pause duration must be more than zero.",
  GuardianNotFound: "That key isn't a guardian.",
  InvalidLimiterConfig: "Limiter settings out of range.",
  WrongVault: "Wrong vault account for this limiter.",
  WrongHold: "Wrong held-withdrawal account.",
  NotTightening: "This loosens a limit: propose it through the timelock.",
  DuplicateGuardian: "Already a guardian.",
  ChangeClosed: "That change was already executed or cancelled.",
  WrongChangeAccounts: "Wrong or missing limiter or hold for this change.",
  InvalidPolicy: "Pause policy values out of range.",
};

/** Errors from outside Breakglass: the protected protocol, tokens, wallet. */
const OTHER_MESSAGES: Record<string, string> = {
  InsufficientPosition: "That's more than you can withdraw.",
  InsufficientFunds: "That's more than your wallet holds.",
  AccountAlreadyInUse: "That already exists.",
  AccountNotInitialized: "That account doesn't exist.",
  WalletNotConnected: "Connect a wallet first.",
  NetworkUnavailable:
    "Couldn't reach the network. Check your connection and try again.",
};

/** The message for an error name, or null if it isn't known. */
export function messageFor(
  errorName: string | null | undefined,
): string | null {
  if (!errorName) return null;
  return (
    BREAKGLASS_MESSAGES[errorName as BreakglassErrorName] ??
    OTHER_MESSAGES[errorName] ??
    null
  );
}
