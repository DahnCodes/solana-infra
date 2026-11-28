/**
 * Plain-words descriptions of Breakglass data, shared by the dashboard, the
 * rules panel and the activity feed. Pure: token names come in through
 * `token`, so this file needs no app config.
 */
import type { ConfigAction, PauseKind } from "./accounts.ts";
import { TEST_VAULT_SCOPE_LABELS } from "./constants.ts";
import type { Address, ScopeId } from "./primitives.ts";
import { formatUnits } from "../format.ts";

export type TokenInfo = { symbol: string; decimals: number };
export type TokenLookup = (mint: Address) => TokenInfo;

const short = (a: string) =>
  a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;

/** A scope's name. The test vault's scopes have names; others are numbered. */
export function scopeLabel(scope: ScopeId): string {
  return TEST_VAULT_SCOPE_LABELS[scope] ?? `Scope ${scope}`;
}

/** Who paused a scope, in words. */
export function pauseKindLabel(kind: PauseKind): string {
  switch (kind) {
    case "guardian":
      return "Paused by the guardian";
    case "autoTrip":
      return "Tripped by the cap";
    case "admin":
      return "Paused by the admin";
  }
}

const percent = (bps: number) => `${(bps / 100).toLocaleString("en-US")}%`;

/** A timelocked config change, in one sentence. */
export function describeAction(
  action: ConfigAction,
  token: TokenLookup,
): string {
  switch (action.kind) {
    case "raiseLimits": {
      const t = token(action.mint);
      const amount = (v: bigint) => `${formatUnits(v, t.decimals)} ${t.symbol}`;
      const cap = action.capBpsOfVault
        ? `${amount(action.capAbsolute)} (or ${percent(action.capBpsOfVault)} of the vault)`
        : amount(action.capAbsolute);
      return `Raise the ${t.symbol} cap to ${cap} per window`;
    }
    case "addGuardian":
      return `Add ${short(action.guardian)} as a guardian`;
    case "setAdmin":
      return `Hand the admin role to ${short(action.admin)}`;
    case "releaseHeld":
      return `Release the frozen withdrawal ${short(action.hold)}`;
    case "changePolicy":
      return "Change the guardian pause limits";
  }
}

/** A duration as hours and minutes: "3 h 05 min", "45 min", "2 d 4 h". */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  return `${m} min`;
}
