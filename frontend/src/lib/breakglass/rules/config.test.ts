/**
 * The Phase 4 config rules, mirroring the tests in config_logic.rs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LimiterParams, PendingConfig } from "../accounts.ts";
import { RuleError } from "../errors.ts";
import { isTightening, requireExecutable } from "./config.ts";

const p = (): LimiterParams => ({
  windowSecs: 3600,
  capAbsolute: BigInt(1000),
  capBpsOfVault: 1000,
  largeThreshold: BigInt(100),
  largeThresholdBps: 500,
  holdSecs: 3600,
  autoTripSecs: 3600,
  instantAllowance: BigInt(50),
  screenSecs: 120,
});

const errorOf = (run: () => void) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof RuleError ? error.errorName : "other";
  }
};

describe("isTightening", () => {
  it("counts the same settings as tightening", () => {
    assert.equal(isTightening(p(), p()), true);
  });

  it("accepts each stricter field and refuses each looser one", () => {
    const stricter: Partial<LimiterParams>[] = [
      { windowSecs: 7200 },
      { capAbsolute: BigInt(999) },
      { capBpsOfVault: 999 },
      { largeThreshold: BigInt(99) },
      { largeThresholdBps: 499 },
      { holdSecs: 3601 },
      { autoTripSecs: 3601 },
      { instantAllowance: BigInt(49) },
      { screenSecs: 121 },
    ];
    const looser: Partial<LimiterParams>[] = [
      { windowSecs: 3599 },
      { capAbsolute: BigInt(1001) },
      { capBpsOfVault: 1001 },
      { capBpsOfVault: 0 },
      { largeThreshold: BigInt(101) },
      { largeThresholdBps: 0 },
      { holdSecs: 3599 },
      { autoTripSecs: 3599 },
      { instantAllowance: BigInt(51) },
      { screenSecs: 119 },
    ];
    for (const f of stricter)
      assert.equal(
        isTightening(p(), { ...p(), ...f }),
        true,
        JSON.stringify(f, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
      );
    for (const f of looser)
      assert.equal(
        isTightening(p(), { ...p(), ...f }),
        false,
        JSON.stringify(f, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
      );
  });

  it("treats adding a bps limit where there was none as tightening", () => {
    const old = { ...p(), capBpsOfVault: 0 };
    assert.equal(isTightening(old, { ...old, capBpsOfVault: 1 }), true);
  });

  it("refuses a mixed change", () => {
    assert.equal(
      isTightening(p(), { ...p(), capAbsolute: BigInt(1), holdSecs: 1 }),
      false,
    );
  });
});

describe("requireExecutable", () => {
  const change = (over: Partial<PendingConfig> = {}): PendingConfig => ({
    bump: 255,
    config: "c",
    id: BigInt(0),
    action: { kind: "setAdmin", admin: "x" },
    proposedBy: "a",
    proposedAt: 0,
    executableAt: 100,
    vetoed: false,
    executed: false,
    cancelled: false,
    ...over,
  });

  it("checks closed, then vetoed, then the timelock", () => {
    assert.equal(
      errorOf(() => requireExecutable(change(), 99)),
      "TimelockActive",
    );
    assert.equal(
      errorOf(() => requireExecutable(change(), 100)),
      null,
    );
    assert.equal(
      errorOf(() => requireExecutable(change({ vetoed: true }), 0)),
      "Vetoed",
    );
    assert.equal(
      errorOf(() =>
        requireExecutable(change({ vetoed: true, cancelled: true }), 0),
      ),
      "ChangeClosed",
    );
    assert.equal(
      errorOf(() => requireExecutable(change({ executed: true }), 200)),
      "ChangeClosed",
    );
  });
});
