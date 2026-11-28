/**
 * What the gate will answer to a withdrawal, before it is sent. Runs the
 * program's own checks (pause first, then evaluate) on a copy of the
 * limiter, so the preview can't drift from what actually happens.
 */
import type { FlowLimiter, ScopePause } from "../accounts.ts";
import type { Seconds, U64, UnixSeconds } from "../primitives.ts";
import { evaluate } from "./limiter.ts";
import { isScopePaused, scopePausedUntil } from "./pauses.ts";

export type Prediction =
  | { kind: "allow" }
  | { kind: "holdLarge"; holdSecs: Seconds }
  | { kind: "holdScreen"; holdSecs: Seconds }
  | { kind: "holdBreach"; holdSecs: Seconds; tripSecs: Seconds }
  | { kind: "deny"; pausedUntil: UnixSeconds };

export function predictWithdrawal(
  limiter: FlowLimiter,
  vaultBalance: U64,
  pauses: ScopePause[],
  amount: U64,
  now: UnixSeconds,
): Prediction {
  if (isScopePaused(pauses, limiter.scope, now)) {
    return {
      kind: "deny",
      pausedUntil: scopePausedUntil(pauses, limiter.scope, now) ?? now,
    };
  }
  const copy = structuredClone(limiter);
  const verdict = evaluate(copy, amount, vaultBalance, now, false);
  switch (verdict.kind) {
    case "allow":
      return { kind: "allow" };
    case "holdLarge":
      return { kind: "holdLarge", holdSecs: limiter.holdSecs };
    case "holdScreen":
      return { kind: "holdScreen", holdSecs: limiter.screenSecs };
    case "holdBreach":
      return {
        kind: "holdBreach",
        holdSecs: limiter.holdSecs,
        tripSecs: limiter.autoTripSecs,
      };
  }
}
