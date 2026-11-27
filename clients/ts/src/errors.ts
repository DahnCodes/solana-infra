// Mirrors programs/breakglass/src/errors.rs. Anchor numbers custom errors from
// 6000 in declaration order, so errors.rs is append-only: never reorder or
// remove a variant, or every code after it changes for the frontend.

export const BREAKGLASS_ERRORS = [
  { code: 6000, name: "ScopePaused", msg: "Scope is paused" },
  { code: 6001, name: "InvalidScope", msg: "Scope id out of range (0..64)" },
  { code: 6002, name: "ScopeUnpausable", msg: "Scope is marked unpausable" },
  { code: 6003, name: "Unauthorized", msg: "Signer is not allowed to perform this action" },
  { code: 6004, name: "TooManyGuardians", msg: "Too many guardians" },
  { code: 6005, name: "PauseTooLong", msg: "Pause duration exceeds the guardian maximum" },
  { code: 6006, name: "RenewCapReached", msg: "Guardian renewal cap reached; admin must extend" },
  { code: 6007, name: "GuardianCooldown", msg: "Guardian is in cooldown" },
  { code: 6008, name: "PauseBudgetExhausted", msg: "Guardian pause budget for this period is used up" },
  { code: 6009, name: "TooManyActivePauses", msg: "Too many active pauses" },
  { code: 6010, name: "HoldNotReleased", msg: "Held withdrawal is not released yet" },
  { code: 6011, name: "HoldFrozen", msg: "Held withdrawal is frozen" },
  { code: 6012, name: "HoldInvalidState", msg: "Held withdrawal is not in a claimable state" },
  { code: 6013, name: "InvalidCaller", msg: "Caller is not the registered protected program" },
  { code: 6014, name: "TimelockActive", msg: "Timelock is still active" },
  { code: 6015, name: "InvalidTimelock", msg: "Timelock value out of allowed range" },
  { code: 6016, name: "Vetoed", msg: "Pending change was vetoed" },
  { code: 6017, name: "InvariantViolated", msg: "Protocol invariant violated" },
  { code: 6018, name: "MathOverflow", msg: "Arithmetic overflow" },
  { code: 6019, name: "NotExecutable", msg: "Account is not executable" },
  { code: 6020, name: "ScopeNotPaused", msg: "Scope is not paused" },
  { code: 6021, name: "InvalidDuration", msg: "Pause duration must be positive" },
  { code: 6022, name: "GuardianNotFound", msg: "Key is not a guardian of this config" },
] as const;

export type BreakglassErrorName = (typeof BREAKGLASS_ERRORS)[number]["name"];

const byCode = new Map<number, (typeof BREAKGLASS_ERRORS)[number]>(
  BREAKGLASS_ERRORS.map((e) => [e.code, e]),
);

/** Look up a Breakglass error by its numeric code. */
export function breakglassError(code: number) {
  return byCode.get(code);
}

/**
 * Best-effort: pull a Breakglass error out of whatever a failed send threw
 * (AnchorError, SendTransactionError, or a raw "custom program error: 0x1770").
 * Only trust the result when the failing program is Breakglass: a protected
 * program has its own 6000+ codes.
 */
export function parseBreakglassError(err: unknown) {
  const e = err as any;
  const code: unknown = e?.error?.errorCode?.number ?? e?.code;
  if (typeof code === "number" && byCode.has(code)) return byCode.get(code);
  const text = [e?.message, ...(e?.logs ?? e?.transactionLogs ?? [])].join("\n");
  const hex = /custom program error: (0x[0-9a-fA-F]+)/.exec(text);
  if (hex) return byCode.get(parseInt(hex[1], 16));
  const named = /Error Code: (\w+)/.exec(text);
  if (named) return BREAKGLASS_ERRORS.find((x) => x.name === named[1]);
  return undefined;
}
