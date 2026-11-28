/**
 * Risk flags on a held withdrawal, so the guardian sees why one might need
 * freezing. Rule-based for now (docs: "Risk flags come from the monitor ...
 * once it exists; until then, rule-based"). Each flag says what was seen,
 * not a verdict.
 */
import type { PendingWithdrawal } from "./accounts.ts";
import type { BreakglassEventRecord } from "./events.ts";
import type { U64 } from "./primitives.ts";

export type RiskFlag = { id: string; label: string };

const WITHDRAWAL_EVENTS = new Set([
  "outflowRecorded",
  "largeWithdrawalQueued",
  "limitHoldQueued",
  "withdrawalScreenQueued",
]);

/** Share of the vault at or above which a hold is flagged, in percent. */
export const LARGE_SHARE_PERCENT = 10;
/** Withdrawals by one wallet within an hour at or above which it is flagged. */
export const VELOCITY_COUNT = 3;

/**
 * @param history the protocol's events, any order (newest first is fine),
 *   or null if they couldn't be read: then the flags that depend on history
 *   are left out rather than guessed.
 */
export function holdRiskFlags(
  hold: PendingWithdrawal,
  vaultBalance: U64 | null,
  history: BreakglassEventRecord[] | null,
): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (hold.kind === "limit") {
    flags.push({ id: "cap", label: "Crossed the window's cap" });
  }
  if (hold.kind === "screen") {
    flags.push({ id: "screen", label: "Held for screening" });
  }

  if (vaultBalance !== null && vaultBalance > BigInt(0)) {
    const share = Number((hold.amount * BigInt(1000)) / vaultBalance) / 10;
    if (share >= LARGE_SHARE_PERCENT) {
      flags.push({ id: "share", label: `${share}% of the vault` });
    }
  }

  if (history === null) return flags;

  // The owner's withdrawals (sent or held) up to and including this one.
  const owners = history.filter(
    (r) =>
      WITHDRAWAL_EVENTS.has(r.event.name) &&
      "owner" in r.event.data &&
      r.event.data.owner === hold.owner &&
      r.blockTime <= hold.createdAt,
  );
  const earlier = owners.filter((r) => r.blockTime < hold.createdAt);
  if (earlier.length === 0) {
    flags.push({ id: "fresh", label: "First withdrawal from this wallet" });
  }
  const lastHour = owners.filter((r) => r.blockTime >= hold.createdAt - 3600);
  if (lastHour.length >= VELOCITY_COUNT) {
    flags.push({
      id: "velocity",
      label: `${lastHour.length} withdrawals within an hour`,
    });
  }

  return flags;
}
