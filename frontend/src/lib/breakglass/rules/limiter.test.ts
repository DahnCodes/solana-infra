import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlowLimiter } from "../accounts.ts";
import {
  bucketsOldestFirst,
  bucketWidth,
  effectiveCap,
  effectiveThreshold,
  evaluate,
  windowUsage,
} from "./limiter.ts";

const n = (x: number) => BigInt(x);

function limiter(over: Partial<FlowLimiter> = {}): FlowLimiter {
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
    bucketStart: 0,
    largeThreshold: n(500),
    largeThresholdBps: 0,
    holdSecs: 100,
    autoTripSecs: 100,
    instantAllowance: BigInt("18446744073709551615"),
    screenSecs: 120,
    ...over,
  };
}

describe("limiter math", () => {
  it("uses buckets of ceil(window / 11)", () => {
    assert.equal(bucketWidth({ windowSecs: 3600 }), 328);
    assert.equal(bucketWidth({ windowSecs: 12 }), 2);
  });

  it("takes the smaller of the absolute and balance-based cap", () => {
    const l = limiter({ capAbsolute: n(1000), capBpsOfVault: 1000 });
    assert.equal(effectiveCap(l, n(5000)), n(500));
    assert.equal(effectiveCap(l, n(50_000)), n(1000));
    assert.equal(effectiveCap(limiter(), n(1)), n(1000));
  });

  it("takes the smaller threshold when bps is set", () => {
    const l = limiter({ largeThreshold: n(500), largeThresholdBps: 100 });
    assert.equal(effectiveThreshold(l, n(10_000)), n(100));
  });

  it("decides in order: threshold, cap, screening", () => {
    const l = limiter({ instantAllowance: n(50) });
    assert.equal(evaluate(l, n(500), n(0), 1000, false).kind, "holdLarge");
    assert.equal(evaluate(l, n(60), n(0), 1000, false).kind, "holdScreen");
    const ok = evaluate(l, n(40), n(0), 1000, false);
    assert.deepEqual(ok, {
      kind: "allow",
      windowTotal: n(40),
      windowCap: n(1000),
    });
    // A claim skips threshold and screening but still counts against the cap.
    assert.equal(evaluate(l, n(500), n(0), 1000, true).kind, "allow");
    assert.equal(evaluate(l, n(470), n(0), 1000, true).kind, "holdBreach");
  });

  it("lets outflow roll off after a full window", () => {
    const l = limiter();
    evaluate(l, n(400), n(0), 1000, false);
    assert.equal(windowUsage(l, 1000), n(400));
    assert.equal(windowUsage(l, 1000 + 11 * 328), n(400)); // still inside
    assert.equal(windowUsage(l, 1000 + 13 * 328), n(0)); // rolled off
    assert.equal(bucketsOldestFirst(l, 1000).at(-1), n(400));
    assert.equal(
      bucketsOldestFirst(l, 1000 + 13 * 328).reduce((a, b) => a + b),
      n(0),
    );
  });
});
