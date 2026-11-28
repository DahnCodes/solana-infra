/**
 * Plain-words descriptions of Breakglass data, shared by the dashboard, the
 * rules panel and the activity feed. Pure: token names come in through
 * `token`, so this file needs no app config.
 */
import type { ConfigAction, PauseKind } from "./accounts.ts";
import type { BreakglassEvent, EventDataByName } from "./events.ts";
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

/** What a hold was, for sentences that name it ("the 250,000 USDC withdrawal"). */
export type HoldLookup = (
  hold: Address,
) => { amount: bigint; mint: Address; owner: Address } | null;

export type EventContext = {
  token: TokenLookup;
  /** A person's name for an address (the demo wallets by name). */
  who: (address: Address) => string;
  hold?: HoldLookup;
  /** Formats a unix time; the default is the ISO date and time. */
  time?: (unix: number) => string;
};

const ACTION_NAMES = [
  "change a token's limits",
  "add a guardian",
  "hand over the admin role",
  "release a frozen withdrawal",
  "change the guardian pause limits",
];

const scopeList = (mask: bigint) => {
  const names: string[] = [];
  for (let s = 0; s < 64; s++) {
    if ((mask >> BigInt(s)) & BigInt(1))
      names.push(scopeLabel(s).toLowerCase());
  }
  return names.join(", ") || "no scope";
};

/** One event, as a sentence about what happened. */
export function describeEvent(
  event: BreakglassEvent,
  ctx: EventContext,
): string {
  const time = ctx.time ?? ((t: number) => new Date(t * 1000).toISOString());
  const money = (amount: bigint, mint: Address) => {
    const t = ctx.token(mint);
    return `${formatUnits(amount, t.decimals)} ${t.symbol}`;
  };
  const holdName = (hold: Address) => {
    const h = ctx.hold?.(hold);
    return h
      ? `the ${money(h.amount, h.mint)} withdrawal to ${ctx.who(h.owner)}`
      : "a held withdrawal";
  };
  const d = event.data;
  switch (event.name) {
    case "configInitialized": {
      const e = d as EventDataByName["configInitialized"];
      const n = e.guardians.length;
      return `Registered the protocol with ${n} guardian${n === 1 ? "" : "s"}`;
    }
    case "paused": {
      const e = d as EventDataByName["paused"];
      return e.kind === 1
        ? `The cap tripped: ${scopeList(e.scopesMask)} paused until ${time(e.pausedUntil)}`
        : `Paused ${scopeList(e.scopesMask)} until ${time(e.pausedUntil)}${e.reason ? ` (reason ${e.reason})` : ""}`;
    }
    case "pauseRenewed": {
      const e = d as EventDataByName["pauseRenewed"];
      return `Extended the pause on ${scopeList(e.scopesMask)} to ${time(e.pausedUntil)}`;
    }
    case "unpaused": {
      const e = d as EventDataByName["unpaused"];
      return `Lifted the pause on ${scopeList(e.scopesMask)}`;
    }
    case "guardianRemoved": {
      const e = d as EventDataByName["guardianRemoved"];
      return `Removed ${ctx.who(e.guardian)} as a guardian`;
    }
    case "outflowRecorded": {
      const e = d as EventDataByName["outflowRecorded"];
      return `${money(e.amount, e.mint)} left the vault to ${ctx.who(e.owner)}`;
    }
    case "largeWithdrawalQueued":
    case "limitHoldQueued":
    case "withdrawalScreenQueued": {
      const e = d as EventDataByName["largeWithdrawalQueued"];
      const why =
        event.name === "largeWithdrawalQueued"
          ? "for size"
          : event.name === "limitHoldQueued"
            ? "at the cap"
            : "for screening";
      return `Held ${money(e.amount, e.mint)} to ${ctx.who(e.owner)} ${why}, until ${time(e.releaseAt)}`;
    }
    case "limitTripped": {
      const e = d as EventDataByName["limitTripped"];
      return `Window cap hit: ${money(e.windowTotal, e.mint)} of ${money(e.windowCap, e.mint)} used`;
    }
    case "holdFrozen": {
      const e = d as EventDataByName["holdFrozen"];
      return `Froze ${holdName(e.hold)}`;
    }
    case "holdResolved": {
      const e = d as EventDataByName["holdResolved"];
      const what = [
        "claimed",
        "released",
        "rejected; the funds went back to the position",
      ][e.outcome];
      return `${capitalize(holdName(e.hold))} was ${what}`;
    }
    case "configChangeProposed": {
      const e = d as EventDataByName["configChangeProposed"];
      const what = ACTION_NAMES[e.actionKind] ?? "change the config";
      return `Proposed to ${what}; executable ${time(e.executableAt)}`;
    }
    case "configChangeExecuted":
      return "Executed a config change";
    case "configChangeVetoed":
      return "Vetoed a config change";
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
