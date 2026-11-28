/**
 * A token limiter's nine settings as people type them, and back. Shared by
 * "Propose a change" (raise limits, timelocked) and "Tighten" (at once).
 * Pure, so it is unit-tested.
 */
import type {
  FlowLimiter,
  LimiterParams,
} from "../../../lib/breakglass/accounts.ts";
import { U64_MAX } from "../../../lib/breakglass/constants.ts";
import { formatUnits, parseUnits } from "../../../lib/format.ts";

export type LimitsDraft = {
  windowMinutes: string;
  cap: string;
  /** Percent of the vault, "" or "0" for none. */
  capPercent: string;
  threshold: string;
  thresholdPercent: string;
  holdHours: string;
  autoTripHours: string;
  /** Largest withdrawal paid without screening; "" for no limit. */
  instantAllowance: string;
  screenMinutes: string;
};

const H = 3600;
const M = 60;

/** Seconds as a short decimal ("1.5"), without trailing zeros. */
const per = (secs: number, unit: number) =>
  String(Math.round((secs / unit) * 100) / 100);
const pct = (bps: number) => (bps === 0 ? "" : String(bps / 100));

export function draftOf(l: FlowLimiter, decimals: number): LimitsDraft {
  return {
    windowMinutes: per(l.windowSecs, M),
    cap: formatUnits(l.capAbsolute, decimals),
    capPercent: pct(l.capBpsOfVault),
    threshold: formatUnits(l.largeThreshold, decimals),
    thresholdPercent: pct(l.largeThresholdBps),
    holdHours: per(l.holdSecs, H),
    autoTripHours: per(l.autoTripSecs, H),
    instantAllowance:
      l.instantAllowance === U64_MAX
        ? ""
        : formatUnits(l.instantAllowance, decimals),
    screenMinutes: per(l.screenSecs, M),
  };
}

function percentToBps(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps <= 10_000 ? bps : null;
}

function seconds(text: string, unit: number): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const s = Math.round(Number(t) * unit);
  return s > 0 ? s : null;
}

function amount(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (t === "0") return BigInt(0);
  return parseUnits(t, decimals);
}

/** Field errors keyed by draft field. */
export type LimitsErrors = Partial<Record<keyof LimitsDraft, string>>;

/** The draft as LimiterParams, or the fields that don't parse. */
export function paramsOf(
  d: LimitsDraft,
  decimals: number,
): { params: LimiterParams } | { errors: LimitsErrors } {
  const errors: LimitsErrors = {};
  const windowSecs = seconds(d.windowMinutes, M);
  if (windowSecs === null) errors.windowMinutes = "Enter a length.";
  const capAbsolute = amount(d.cap, decimals);
  if (!capAbsolute) errors.cap = "Enter an amount above zero.";
  const capBpsOfVault = percentToBps(d.capPercent);
  if (capBpsOfVault === null) errors.capPercent = "0 to 100, two decimals.";
  const largeThreshold = amount(d.threshold, decimals);
  if (largeThreshold === null) errors.threshold = "Enter an amount.";
  const largeThresholdBps = percentToBps(d.thresholdPercent);
  if (largeThresholdBps === null)
    errors.thresholdPercent = "0 to 100, two decimals.";
  const holdSecs = seconds(d.holdHours, H);
  if (holdSecs === null) errors.holdHours = "Enter a length.";
  const autoTripSecs = seconds(d.autoTripHours, H);
  if (autoTripSecs === null) errors.autoTripHours = "Enter a length.";
  const instantAllowance =
    d.instantAllowance.trim() === ""
      ? U64_MAX
      : amount(d.instantAllowance, decimals);
  if (instantAllowance === null)
    errors.instantAllowance = "Enter an amount, or leave empty for no limit.";
  const screenSecs = seconds(d.screenMinutes, M);
  if (screenSecs === null) errors.screenMinutes = "Enter a length.";
  if (Object.keys(errors).length) return { errors };
  return {
    params: {
      windowSecs: windowSecs!,
      capAbsolute: capAbsolute!,
      capBpsOfVault: capBpsOfVault!,
      largeThreshold: largeThreshold!,
      largeThresholdBps: largeThresholdBps!,
      holdSecs: holdSecs!,
      autoTripSecs: autoTripSecs!,
      instantAllowance: instantAllowance!,
      screenSecs: screenSecs!,
    },
  };
}

/** People's names for each setting, in form order. */
export const SETTING_LABELS: Record<keyof LimiterParams, string> = {
  windowSecs: "window",
  capAbsolute: "cap",
  capBpsOfVault: "cap as a share of the vault",
  largeThreshold: "hold threshold",
  largeThresholdBps: "threshold as a share of the vault",
  holdSecs: "hold time",
  autoTripSecs: "auto-trip pause",
  instantAllowance: "instant allowance",
  screenSecs: "screening time",
};

const bpsLooser = (old: number, next: number) =>
  !(next === old || (next !== 0 && (old === 0 || next <= old)));

/** The settings `next` loosens compared with `old` (isTightening, per field). */
export function loosenedSettings(
  old: LimiterParams,
  next: LimiterParams,
): (keyof LimiterParams)[] {
  const out: (keyof LimiterParams)[] = [];
  if (next.windowSecs < old.windowSecs) out.push("windowSecs");
  if (next.capAbsolute > old.capAbsolute) out.push("capAbsolute");
  if (bpsLooser(old.capBpsOfVault, next.capBpsOfVault))
    out.push("capBpsOfVault");
  if (next.largeThreshold > old.largeThreshold) out.push("largeThreshold");
  if (bpsLooser(old.largeThresholdBps, next.largeThresholdBps))
    out.push("largeThresholdBps");
  if (next.holdSecs < old.holdSecs) out.push("holdSecs");
  if (next.autoTripSecs < old.autoTripSecs) out.push("autoTripSecs");
  if (next.instantAllowance > old.instantAllowance)
    out.push("instantAllowance");
  if (next.screenSecs < old.screenSecs) out.push("screenSecs");
  return out;
}

/** True if nothing changes. */
export function sameParams(a: LimiterParams, b: LimiterParams): boolean {
  return (Object.keys(a) as (keyof LimiterParams)[]).every(
    (k) => a[k] === b[k],
  );
}
