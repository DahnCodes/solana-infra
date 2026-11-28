import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeAction,
  formatSpan,
  pauseKindLabel,
  scopeLabel,
} from "./describe.ts";

const token = () => ({ symbol: "USDC", decimals: 6 });

describe("plain-words descriptions", () => {
  it("names scopes and pause kinds", () => {
    assert.equal(scopeLabel(1), "Withdrawals");
    assert.equal(scopeLabel(9), "Scope 9");
    assert.equal(pauseKindLabel("autoTrip"), "Tripped by the cap");
  });

  it("describes config changes in one sentence", () => {
    assert.equal(
      describeAction(
        {
          kind: "raiseLimits",
          mint: "m",
          capAbsolute: BigInt(250_000_000_000),
          capBpsOfVault: 1500,
          largeThreshold: BigInt(0),
          largeThresholdBps: 0,
        },
        token,
      ),
      "Raise the USDC cap to 250,000 USDC (or 15% of the vault) per window",
    );
    assert.equal(
      describeAction(
        {
          kind: "addGuardian",
          guardian: "HPQtaVC5UeCLwrgjcXMJYyKzVwUXeQkWVegLojSK5Kht",
        },
        token,
      ),
      "Add HPQt…5Kht as a guardian",
    );
  });

  it("formats spans of time", () => {
    assert.equal(formatSpan(45 * 60), "45 min");
    assert.equal(formatSpan(3 * 3600 + 5 * 60), "3 h 05 min");
    assert.equal(formatSpan(52 * 3600), "2 d 4 h");
    assert.equal(formatSpan(-5), "0 min");
  });
});
