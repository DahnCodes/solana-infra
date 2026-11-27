/**
 * Breakglass program errors (docs/FRONTEND.md section 8). Codes are stable:
 * errors.rs is append-only. Step 5.4 turns these into the messages people
 * see; here they only identify what failed.
 */
import type { ClientError } from "./client.ts";
import type { Address } from "./primitives.ts";

export const BREAKGLASS_ERRORS = {
  ScopePaused: 6000,
  InvalidScope: 6001,
  ScopeUnpausable: 6002,
  Unauthorized: 6003,
  TooManyGuardians: 6004,
  PauseTooLong: 6005,
  RenewCapReached: 6006,
  GuardianCooldown: 6007,
  PauseBudgetExhausted: 6008,
  TooManyActivePauses: 6009,
  HoldNotReleased: 6010,
  HoldFrozen: 6011,
  HoldInvalidState: 6012,
  InvalidCaller: 6013,
  TimelockActive: 6014,
  InvalidTimelock: 6015,
  Vetoed: 6016,
  InvariantViolated: 6017,
  MathOverflow: 6018,
  NotExecutable: 6019,
  ScopeNotPaused: 6020,
  InvalidDuration: 6021,
  GuardianNotFound: 6022,
  InvalidLimiterConfig: 6023,
  WrongVault: 6024,
  WrongHold: 6025,
} as const;

export type BreakglassErrorName = keyof typeof BREAKGLASS_ERRORS;

/** Thrown by the rules when the program would reject the instruction. */
export class RuleError extends Error {
  readonly errorName: BreakglassErrorName;
  constructor(errorName: BreakglassErrorName) {
    super(errorName);
    this.name = "RuleError";
    this.errorName = errorName;
  }
}

/** Fails with `name` unless `condition` holds, like the program's require!. */
export function require(
  condition: boolean,
  name: BreakglassErrorName,
): asserts condition {
  if (!condition) throw new RuleError(name);
}

/** Builds the ClientError a failed write rejects with. */
export function clientError(
  message: string,
  details: {
    code?: number | null;
    errorName?: string | null;
    program?: Address | null;
  } = {},
): ClientError {
  const error = new Error(message) as ClientError;
  error.name = "ClientError";
  error.code = details.code ?? null;
  error.errorName = details.errorName ?? null;
  error.program = details.program ?? null;
  return error;
}

/** True if a thrown value is a ClientError. */
export function isClientError(value: unknown): value is ClientError {
  return value instanceof Error && value.name === "ClientError";
}
