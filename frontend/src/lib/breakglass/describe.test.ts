import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeAction,
  describeEvent,
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

  it("describes events as sentences", () => {
    const ctx = {
      token,
      who: (a: string) => (a === "ada" ? "Ada" : a),
      hold: () => ({
        amount: BigInt(250_000_000_000),
        mint: "m",
        owner: "ada",
      }),
      time: (t: number) => `t${t}`,
    };
    assert.equal(
      describeEvent(
        {
          name: "paused",
          data: {
            config: "c",
            scopesMask: BigInt(2),
            pausedUntil: 9,
            by: "g",
            kind: 1,
            reason: 1,
          },
        },
        ctx,
      ),
      "The cap tripped: withdrawals paused until t9",
    );
    assert.equal(
      describeEvent(
        {
          name: "largeWithdrawalQueued",
          data: {
            config: "c",
            hold: "h",
            mint: "m",
            owner: "ada",
            amount: BigInt(1_000_000),
            releaseAt: 5,
          },
        },
        ctx,
      ),
      "Held 1 USDC to Ada for size, until t5",
    );
    assert.equal(
      describeEvent(
        { name: "holdResolved", data: { config: "c", hold: "h", outcome: 2 } },
        ctx,
      ),
      "The 250,000 USDC withdrawal to Ada was rejected; the funds went back to the position",
    );
  });

  it("formats spans of time", () => {
    assert.equal(formatSpan(45 * 60), "45 min");
    assert.equal(formatSpan(3 * 3600 + 5 * 60), "3 h 05 min");
    assert.equal(formatSpan(52 * 3600), "2 d 4 h");
    assert.equal(formatSpan(-5), "0 min");
  });
});
