import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingConfig, PendingWithdrawal } from "./accounts.ts";
import type { BreakglassEventRecord } from "./events.ts";
import {
  canClaim,
  canExecute,
  canFreeze,
  canPause,
  canProposeRelease,
  canReject,
  canRenew,
  canUnpause,
  canVeto,
  roleOf,
} from "./permissions.ts";
import { holdRiskFlags } from "./risk.ts";

const hold = (over: Partial<PendingWithdrawal> = {}): PendingWithdrawal => ({
  bump: 255,
  config: "c",
  owner: "ada",
  mint: "m",
  amount: BigInt(250),
  nonce: BigInt(1),
  createdAt: 1000,
  releaseAt: 2000,
  status: "queued",
  scope: 1,
  kind: "large",
  ...over,
});

const change = (over: Partial<PendingConfig> = {}): PendingConfig => ({
  bump: 255,
  config: "c",
  id: BigInt(0),
  action: { kind: "setAdmin", admin: "x" },
  proposedAt: 0,
  executableAt: 100,
  vetoed: false,
  executed: false,
  ...over,
});

describe("permissions", () => {
  it("reads roles, admin first", () => {
    const cfg = { admin: "a", guardians: ["g", "a"] } as never;
    assert.equal(roleOf(cfg, "a"), "admin");
    assert.equal(roleOf(cfg, "g"), "guardian");
    assert.equal(roleOf(cfg, "u"), "user");
    assert.equal(roleOf(cfg, null), null);
  });

  it("lets guardians freeze and only the admin reject or release", () => {
    assert.equal(canFreeze("guardian", hold()).allowed, true);
    assert.equal(canFreeze("user", hold()).allowed, false);
    assert.equal(canFreeze("admin", hold({ status: "frozen" })).allowed, false);
    assert.equal(canReject("guardian", hold()).allowed, false);
    assert.equal(canReject("admin", hold({ status: "frozen" })).allowed, true);
    assert.equal(
      canReject("admin", hold({ status: "claimed" })).allowed,
      false,
    );
    assert.equal(
      canProposeRelease("admin", hold({ status: "frozen" }), null).allowed,
      true,
    );
    assert.equal(canProposeRelease("admin", hold(), null).allowed, false);
    assert.equal(
      canProposeRelease("admin", hold({ status: "frozen" }), change()).allowed,
      false,
    );
  });

  it("lets only the owner claim, after the hold and while open", () => {
    assert.equal(canClaim("ada", hold(), 2000, false).allowed, true);
    assert.equal(canClaim("ada", hold(), 1999, false).allowed, false);
    assert.equal(canClaim("ben", hold(), 2000, false).allowed, false);
    assert.equal(canClaim("ada", hold(), 2000, true).allowed, false);
    assert.equal(
      canClaim("ada", hold({ status: "released" }), 0, false).allowed,
      true,
    );
    const frozen = canClaim("ada", hold({ status: "frozen" }), 5000, false);
    assert.equal(frozen.allowed, false);
  });

  it("gates changes on the timelock and on who acts", () => {
    assert.equal(canExecute("anyone", change(), 99).allowed, false);
    assert.equal(canExecute("anyone", change(), 100).allowed, true);
    assert.equal(
      canExecute("anyone", change({ vetoed: true }), 200).allowed,
      false,
    );
    assert.equal(canVeto("guardian", change()).allowed, true);
    assert.equal(canVeto("admin", change()).allowed, false);
  });
});

describe("pause permissions (the program's rules on copies)", () => {
  const H = 3600;
  const config = {
    admin: "admin",
    guardians: ["g"],
    unpausableMask: BigInt(8),
    policy: {
      maxGuardianPauseSecs: 24 * H,
      maxRenewals: 2,
      cooldownSecs: 6 * H,
      budgetSecsPerPeriod: 96 * H,
      budgetPeriodSecs: 30 * 24 * H,
      autoTripSecs: H,
    },
  } as never;
  const state = {
    bump: 255,
    config: "c",
    active: [
      {
        scope: 2,
        pausedUntil: 10 * H,
        pausedBy: "g",
        kind: "guardian" as const,
        renewals: 0,
        reason: 0,
      },
    ],
  };
  const ledger = {
    bump: 255,
    config: "c",
    guardian: "g",
    periodStart: 0,
    pauseSecsUsed: 6 * H,
    lastPauseEnd: 10 * H,
  };
  const ctx = (wallet: string) => ({
    config,
    configAddress: "c",
    state,
    ledger: wallet === "g" ? ledger : null,
    wallet,
    now: 5 * H,
  });

  it("says why a guardian can't pause, and leaves the state alone", () => {
    const p = canPause(ctx("g"), BigInt(2), H);
    assert.deepEqual(p, {
      allowed: false,
      reason: "Guardian is cooling down.",
    });
    assert.equal(state.active.length, 1);
    assert.equal(canPause(ctx("admin"), BigInt(2), 72 * H).allowed, true);
    assert.equal(canPause(ctx("admin"), BigInt(8), H).allowed, false);
  });

  it("lets a guardian renew and lift only its own pause", () => {
    assert.equal(canRenew(ctx("g"), BigInt(4)).allowed, true);
    assert.equal(canUnpause(ctx("g"), BigInt(4)).allowed, true);
    assert.equal(canUnpause(ctx("someone"), BigInt(4)).allowed, false);
    assert.equal(canUnpause(ctx("admin"), BigInt(2)).allowed, false);
  });
});

describe("risk flags", () => {
  const rec = (
    name: string,
    owner: string,
    at: number,
  ): BreakglassEventRecord =>
    ({
      event: { name, data: { owner } },
      signature: "s",
      slot: 1,
      blockTime: at,
    }) as never;

  it("flags a first withdrawal and a large share of the vault", () => {
    const ids = holdRiskFlags(hold(), BigInt(1000), [
      rec("largeWithdrawalQueued", "ada", 1000),
    ]).map((f) => f.id);
    assert.deepEqual(ids.sort(), ["fresh", "share"]);
  });

  it("flags many withdrawals within an hour, and cap breaches", () => {
    const history = [
      rec("outflowRecorded", "ada", 100),
      rec("outflowRecorded", "ada", 500),
      rec("outflowRecorded", "ada", 900),
      rec("limitHoldQueued", "ada", 1000),
    ];
    const flags = holdRiskFlags(
      hold({ kind: "limit" }),
      BigInt(1_000_000),
      history,
    );
    assert.deepEqual(
      flags.map((f) => f.id),
      ["cap", "velocity"],
    );
    assert.equal(flags[1].label, "4 withdrawals within an hour");
  });
});
