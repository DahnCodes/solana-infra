/**
 * The register form's data: what people type (strings), how it is checked,
 * and how it becomes the arguments of initialize_config and one
 * init_flow_limiter per token. Pure, so it is unit-tested.
 */
import type {
  InitFlowLimiterArgs,
  InitializeConfigArgs,
} from "../../../lib/breakglass/client.ts";
import {
  DEFAULTS,
  MAX_GUARDIANS,
  scopeMask,
} from "../../../lib/breakglass/constants.ts";
import { parseUnits } from "../../../lib/format.ts";

export type LimiterForm = {
  id: number;
  /** A name for people, such as "USDC". Not sent on chain. */
  symbol: string;
  mint: string;
  /** The protocol's vault token account for this mint. */
  vault: string;
  decimals: string;
  /** The outflow scope this limiter gates and auto-trips. */
  scope: string;
  windowMinutes: string;
  cap: string;
  /** Cap as a share of the vault balance, in percent ("" = none). */
  capPercent: string;
  threshold: string;
  thresholdPercent: string;
  holdHours: string;
  /** Zero-loss mode: hold every withdrawal for screening. */
  screenAll: boolean;
};

export type RegisterForm = {
  program: string;
  /** The admin's address; empty means the connected wallet. */
  admin: string;
  guardians: string[];
  /** Scopes that can never be paused. */
  unpausable: number[];
  timelockHours: string;
  limiters: LimiterForm[];
};

/** The scopes the form offers (protocols number their own; 0 to 7 is plenty). */
export const FORM_SCOPES = [0, 1, 2, 3, 4, 5, 6, 7];

export const TIMELOCK_HOURS = {
  min: DEFAULTS.minTimelockSecs / 3600,
  max: DEFAULTS.maxTimelockSecs / 3600,
};

export function newLimiter(id: number): LimiterForm {
  return {
    id,
    symbol: "USDC",
    mint: "",
    vault: "",
    decimals: "6",
    scope: "1",
    windowMinutes: String(DEFAULTS.windowSecs / 60),
    cap: "",
    capPercent: "",
    threshold: "",
    thresholdPercent: "",
    holdHours: String(DEFAULTS.holdSecs / 3600),
    screenAll: false,
  };
}

export function emptyForm(): RegisterForm {
  return {
    program: "",
    admin: "",
    guardians: [""],
    unpausable: [],
    timelockHours: String(TIMELOCK_HOURS.max),
    limiters: [newLimiter(1)],
  };
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isAddress = (s: string) => ADDRESS.test(s.trim());

/** A typed percentage ("2.5") as basis points, or null if invalid. */
export function percentToBps(text: string): number | null {
  const t = text.trim();
  if (t === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const bps = Math.round(Number(t) * 100);
  return bps <= 10_000 ? bps : null;
}

function positiveNumber(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

function decimalsOf(l: LimiterForm): number | null {
  const d = Number(l.decimals);
  return Number.isInteger(d) && d >= 0 && d <= 12 ? d : null;
}

/** Field errors keyed by path ("program", "guardians.1", "limiters.0.cap"). */
export type FormErrors = Record<string, string>;

export function validate(form: RegisterForm): FormErrors {
  const errors: FormErrors = {};

  if (!isAddress(form.program)) {
    errors.program = "Enter the program's address (base58).";
  }
  if (form.admin.trim() && !isAddress(form.admin)) {
    errors.admin = "Enter the admin's address (base58), or leave it empty.";
  }

  const guardians = form.guardians.map((g) => g.trim());
  const filled = guardians.filter(Boolean);
  if (filled.length === 0) {
    errors["guardians.0"] = "Add at least one guardian.";
  }
  if (filled.length > MAX_GUARDIANS) {
    errors.guardians = `Up to ${MAX_GUARDIANS} guardians.`;
  }
  guardians.forEach((g, i) => {
    if (g && !isAddress(g)) errors[`guardians.${i}`] = "Not a Solana address.";
    else if (g && guardians.indexOf(g) !== i)
      errors[`guardians.${i}`] = "Already listed.";
  });

  const hours = positiveNumber(form.timelockHours);
  if (
    hours === null ||
    hours < TIMELOCK_HOURS.min ||
    hours > TIMELOCK_HOURS.max
  ) {
    errors.timelockHours = `Between ${TIMELOCK_HOURS.min} and ${TIMELOCK_HOURS.max} hours.`;
  }

  if (form.limiters.length === 0) {
    errors.limiters = "Add a limiter for at least one token.";
  }
  const mints: string[] = [];
  form.limiters.forEach((l, i) => {
    const at = (field: string) => `limiters.${i}.${field}`;
    if (!isAddress(l.mint))
      errors[at("mint")] = "Enter the token's mint address.";
    else if (mints.includes(l.mint.trim()))
      errors[at("mint")] = "This token already has a limiter.";
    mints.push(l.mint.trim());
    if (!isAddress(l.vault))
      errors[at("vault")] = "Enter the vault's token account.";

    const decimals = decimalsOf(l);
    if (decimals === null) errors[at("decimals")] = "A whole number, 0 to 12.";

    const scope = Number(l.scope);
    if (form.unpausable.includes(scope)) {
      errors[at("scope")] =
        "This scope is always open, so it can't be paused. Pick another.";
    }

    const minutes = positiveNumber(l.windowMinutes);
    if (minutes === null || minutes * 60 < 12) {
      errors[at("windowMinutes")] = "At least 1 minute.";
    }
    if (decimals !== null) {
      const cap = parseUnits(l.cap, decimals);
      if (cap === null || cap === BigInt(0)) {
        errors[at("cap")] = "Enter a cap above zero.";
      }
      const threshold = parseUnits(l.threshold, decimals);
      if (threshold === null || threshold === BigInt(0)) {
        errors[at("threshold")] = "Enter an amount above zero.";
      }
    }
    if (percentToBps(l.capPercent) === null) {
      errors[at("capPercent")] =
        "A percentage up to 100, two decimals at most.";
    }
    if (percentToBps(l.thresholdPercent) === null) {
      errors[at("thresholdPercent")] =
        "A percentage up to 100, two decimals at most.";
    }
    if (positiveNumber(l.holdHours) === null) {
      errors[at("holdHours")] = "More than zero hours.";
    }
  });

  return errors;
}

/** The admin the form names: the typed address, or the connected wallet. */
export const adminOf = (form: RegisterForm, wallet: string) =>
  form.admin.trim() || wallet;

/** The instruction arguments. Call only when validate() returns no errors. */
export function toConfigArgs(
  form: RegisterForm,
  wallet: string,
): InitializeConfigArgs {
  return {
    protectedProgram: form.program.trim(),
    admin: adminOf(form, wallet),
    guardians: form.guardians.map((g) => g.trim()).filter(Boolean),
    unpausableMask: form.unpausable.length
      ? scopeMask(...form.unpausable)
      : BigInt(0),
    timelockSecs: Math.round(Number(form.timelockHours) * 3600),
  };
}

export function toLimiterArgs(
  l: LimiterForm,
  config: string,
): InitFlowLimiterArgs {
  const decimals = decimalsOf(l) ?? 0;
  return {
    config,
    mint: l.mint.trim(),
    vault: l.vault.trim(),
    scope: Number(l.scope),
    windowSecs: Math.round(Number(l.windowMinutes) * 60),
    capAbsolute: parseUnits(l.cap, decimals) ?? BigInt(0),
    capBpsOfVault: percentToBps(l.capPercent) ?? 0,
    largeThreshold: parseUnits(l.threshold, decimals) ?? BigInt(0),
    largeThresholdBps: percentToBps(l.thresholdPercent) ?? 0,
    holdSecs: Math.round(Number(l.holdHours) * 3600),
    autoTripSecs: null,
    instantAllowance: l.screenAll ? BigInt(0) : null,
    screenSecs: null,
  };
}
