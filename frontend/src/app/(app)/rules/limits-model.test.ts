import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlowLimiter } from "../../../lib/breakglass/accounts.ts";
import { U64_MAX } from "../../../lib/breakglass/constants.ts";
import {
  draftOf,
  loosenedSettings,
  paramsOf,
  sameParams,
} from "./limits-model.ts";

const limiter = {
  windowSecs: 3600,
  capAbsolute: BigInt(150_000_000_000),
  capBpsOfVault: 1500,
  largeThreshold: BigInt(100_000_000_000),
  largeThresholdBps: 0,
  holdSecs: 6 * 3600,
  autoTripSecs: 3600,
  instantAllowance: U64_MAX,
  screenSecs: 120,
} as FlowLimiter;

const params = (d: ReturnType<typeof draftOf>) => {
  const out = paramsOf(d, 6);
  assert.ok("params" in out);
  return out.params;
};

describe("limits form", () => {
  it("round-trips a limiter's settings", () => {
    const d = draftOf(limiter, 6);
    assert.equal(d.cap, "150,000");
    assert.equal(d.capPercent, "15");
    assert.equal(d.thresholdPercent, "");
    assert.equal(d.windowMinutes, "60");
    assert.equal(d.instantAllowance, "");
    assert.equal(d.screenMinutes, "2");
    assert.ok(sameParams(params(d), { ...limiter }));
  });

  it("names the fields that don't parse", () => {
    const out = paramsOf(
      { ...draftOf(limiter, 6), cap: "0", capPercent: "101", holdHours: "x" },
      6,
    );
    assert.ok("errors" in out);
    assert.deepEqual(Object.keys(out.errors).sort(), [
      "cap",
      "capPercent",
      "holdHours",
    ]);
  });

  it("lists exactly the settings that loosen", () => {
    const old = params(draftOf(limiter, 6));
    const next = params({
      ...draftOf(limiter, 6),
      cap: "200000",
      holdHours: "12",
      capPercent: "",
    });
    assert.deepEqual(loosenedSettings(old, next), [
      "capAbsolute",
      "capBpsOfVault",
    ]);
    assert.deepEqual(
      loosenedSettings(old, { ...old, instantAllowance: BigInt(5) }),
      [],
    );
  });
});
