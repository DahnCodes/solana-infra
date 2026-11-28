import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlowLimiter, ScopePause } from "../accounts.ts";
import { windowUsage } from "./limiter.ts";
import { predictWithdrawal } from "./predict.ts";

const n = (x: number) => BigInt(x);
const NOW = 100_000;

function limiter(): FlowLimiter {
  return {
    bump: 255,
    config: "c",
    mint: "m",
    vault: "v",
    scope: 1,
    windowSecs: 3600,
    capAbsolute: n(1000),
    capBpsOfVault: 0,
    buckets: Array.from({ length: 12 }, () => n(0)),
    bucketStart: NOW,
    largeThreshold: n(500),
    largeThresholdBps: 0,
    holdSecs: 21_600,
    autoTripSecs: 3600,
    instantAllowance: BigInt("18446744073709551615"),
    screenSecs: 120,
  };
}

describe("predictWithdrawal", () => {
  it("allows under the threshold and the cap, without touching the limiter", () => {
    const l = limiter();
    assert.deepEqual(predictWithdrawal(l, n(0), [], n(100), NOW), {
      kind: "allow",
    });
    assert.equal(windowUsage(l, NOW), n(0));
  });

  it("holds at the threshold, and on a cap breach", () => {
    const l = limiter();
    assert.equal(predictWithdrawal(l, n(0), [], n(500), NOW).kind, "holdLarge");
    l.buckets[0] = n(900);
    l.bucketStart = 0;
    assert.equal(predictWithdrawal(l, n(0), [], n(200), 10).kind, "holdBreach");
  });

  it("denies while the scope is paused", () => {
    const pause: ScopePause = {
      scope: 1,
      pausedUntil: NOW + 60,
      pausedBy: "g",
      kind: "guardian",
      renewals: 0,
      reason: 0,
    };
    assert.deepEqual(predictWithdrawal(limiter(), n(0), [pause], n(1), NOW), {
      kind: "deny",
      pausedUntil: NOW + 60,
    });
  });
});
