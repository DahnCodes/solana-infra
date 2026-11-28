/**
 * Every BreakglassClient method in mock mode, and the gate's rules behind
 * them. Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { scopeMask, TEST_VAULT_SCOPES as S } from "../constants.ts";
import type {
  BreakglassEvent,
  BreakglassEventName,
  EventDataByName,
} from "../events.ts";
import { windowUsage } from "../rules/limiter.ts";
import { MockClient, mockTestVault } from "./client.ts";
import { walletTokenAccount } from "./engine.ts";
import { MOCK_WALLETS as W, usdc } from "./seed.ts";

const H = 3600;
const T = 1_795_000_000; // fixed "real" time, unix seconds
const PROGRAM = "AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB";
const TEST_VAULT = mockTestVault(
  "2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn",
  null,
);

function makeClient(seed = true) {
  return new MockClient({
    breakglassProgram: PROGRAM,
    testVault: TEST_VAULT,
    latencyMs: 0,
    seed,
    realNow: () => T * 1000,
  });
}

/** Asserts a write rejects with the named program error. */
async function rejects(
  promise: Promise<unknown>,
  errorName: string,
  code?: number,
) {
  await assert.rejects(promise, (error: unknown) => {
    const e = error as { name: string; errorName: string; code: number | null };
    assert.equal(e.name, "ClientError");
    assert.equal(e.errorName, errorName);
    if (code !== undefined) assert.equal(e.code, code);
    return true;
  });
}

const names = (events: { name: BreakglassEventName }[]) =>
  events.map((e) => e.name);

/** The fields of the first event called `name`, typed for that event. */
function dataOf<N extends BreakglassEventName>(
  events: BreakglassEvent[],
  name: N,
): EventDataByName[N] {
  const event = events.find((e) => e.name === name);
  assert.ok(event, `expected a ${name} event`);
  return event.data as EventDataByName[N];
}

let client: MockClient;
let config: string;
const vault = TEST_VAULT.vault;

async function holdsOf(owner: string) {
  return client.listHolds(config, { owner });
}

beforeEach(async () => {
  client = makeClient();
  const found = await client.getConfig(TEST_VAULT.program);
  assert.ok(found);
  config = found.address;
});

describe("reads on the demo state", () => {
  it("reads the clock, configs, pause state, limiter and balances", async () => {
    assert.equal(await client.getClock(), T);
    assert.equal((await client.listConfigs()).length, 1);
    const cfg = (await client.getConfig(TEST_VAULT.program))!.account;
    assert.equal(cfg.admin, W.admin.address);
    assert.deepEqual(cfg.guardians, [W.guardian.address]);
    assert.equal(cfg.unpausableMask, scopeMask(S.repay));

    const pauses = (await client.getPauseState(config))!.account.active;
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0].scope, S.borrow);
    assert.equal(pauses[0].kind, "guardian");
    assert.equal(pauses[0].pausedUntil, T + 4 * H);

    const [limiter] = await client.listFlowLimiters(config);
    assert.equal(windowUsage(limiter.account, T), usdc(40_500));
    assert.equal(
      await client.getTokenBalance(TEST_VAULT.tokenAccount),
      usdc(2_000_000),
    );
    assert.equal(
      await client.getTokenBalance(
        walletTokenAccount(W.user.address, TEST_VAULT.mint),
      ),
      usdc(65_500),
    );
  });

  it("reads holds, changes, ledgers, positions, events and incidents", async () => {
    const holds = await client.listHolds(config);
    assert.deepEqual(
      holds.map((h) => [h.account.amount, h.account.status]),
      [
        [usdc(250_000), "queued"],
        [usdc(180_000), "frozen"],
        [usdc(120_000), "queued"],
      ],
    );
    assert.equal((await holdsOf(W.user.address)).length, 2);
    assert.equal(
      (await client.listHolds(config, { status: "frozen" })).length,
      1,
    );

    const [change] = await client.listPendingChanges(config);
    assert.equal(change.account.action.kind, "raiseLimits");
    assert.equal(change.account.executableAt, T + 28 * H);

    const ledger = await client.getGuardianLedger(config, W.guardian.address);
    assert.equal(ledger?.account.pauseSecsUsed, 6 * H);
    assert.equal(await client.getGuardianLedger(config, W.user.address), null);

    assert.deepEqual(await client.getPosition(vault, W.user.address), {
      owner: W.user.address,
      vault,
      amount: usdc(189_500),
      held: usdc(370_000),
    });
    assert.equal(await client.getPosition(vault, W.admin.address), null);

    const page = await client.listEvents(config, { limit: 3 });
    assert.equal(page.items.length, 3);
    assert.equal(page.items[0].event.name, "outflowRecorded");
    const next = await client.listEvents(config, {
      limit: 3,
      cursor: page.nextCursor,
    });
    assert.notEqual(next.items[0].signature, page.items[0].signature);

    const incidents = await client.listIncidents();
    assert.ok(incidents.length >= 4);
    assert.equal((await client.listIncidents("acked")).length, 1);
    const detail = await client.getIncident(incidents[0].id);
    assert.ok(detail && detail.events.length > 0);
    assert.equal(await client.getIncident("nope"), null);
  });
});

describe("withdrawals through the gate", () => {
  it("allows a small withdrawal and records it", async () => {
    const result = await client.withdraw({ vault, amount: usdc(1_000) });
    assert.equal(result.decision, "allow");
    assert.deepEqual(names(result.events), ["outflowRecorded"]);
    const [limiter] = await client.listFlowLimiters(config);
    assert.equal(windowUsage(limiter.account, T), usdc(41_500));
  });

  it("holds a large withdrawal until releaseAt", async () => {
    const result = await client.withdraw({ vault, amount: usdc(100_000) });
    assert.equal(result.decision, "hold");
    if (result.decision !== "hold") return;
    assert.equal(result.releaseAt, T + 6 * H);
    assert.deepEqual(names(result.events), ["largeWithdrawalQueued"]);
    const position = await client.getPosition(vault, W.user.address);
    assert.equal(position?.held, usdc(470_000));
  });

  it("auto-trips the scope when the cap would be crossed, then denies", async () => {
    await client.withdraw({ vault, amount: usdc(99_000) }); // 139,500 of 150,000
    const result = await client.withdraw({ vault, amount: usdc(20_000) });
    assert.equal(result.decision, "hold");
    assert.deepEqual(names(result.events), [
      "limitTripped",
      "paused",
      "limitHoldQueued",
    ]);

    await rejects(
      client.withdraw({ vault, amount: usdc(1) }),
      "ScopePaused",
      6000,
    );

    client.setWallet(W.guardian.address);
    await rejects(
      client.unpause({ config, scopes: scopeMask(S.withdraw) }),
      "Unauthorized",
    );
    client.setWallet(W.admin.address);
    const lifted = await client.unpause({
      config,
      scopes: scopeMask(S.withdraw),
    });
    assert.deepEqual(names(lifted.events), ["unpaused"]);
  });

  it("rejects a withdrawal over the position and changes nothing", async () => {
    const before = await client.getPosition(vault, W.user.address);
    await rejects(
      client.withdraw({ vault, amount: usdc(1_000_000) }),
      "InsufficientPosition",
    );
    assert.deepEqual(await client.getPosition(vault, W.user.address), before);
  });

  it("needs a connected wallet", async () => {
    client.setWallet(null);
    await rejects(
      client.withdraw({ vault, amount: usdc(1) }),
      "WalletNotConnected",
    );
  });
});

describe("deposits", () => {
  it("deposits, refuses overdrafts, and respects a deposit pause", async () => {
    await client.deposit({ vault, amount: usdc(10_000) });
    assert.equal(
      (await client.getPosition(vault, W.user.address))?.amount,
      usdc(199_500),
    );
    await rejects(
      client.deposit({ vault, amount: usdc(1_000_000) }),
      "InsufficientFunds",
    );

    client.setWallet(W.admin.address);
    await client.pause({
      config,
      scopes: scopeMask(S.deposit),
      duration: H,
      reason: 0,
    });
    client.setWallet(W.user.address);
    await rejects(client.deposit({ vault, amount: usdc(1) }), "ScopePaused");
  });
});

describe("holds", () => {
  it("claims a released hold, counting it against the window", async () => {
    const [claimable] = (await holdsOf(W.user.address)).filter(
      (h) => h.account.amount === usdc(120_000),
    );
    // 40,500 + 120,000 would cross the 150,000 cap: the claim trips the scope.
    const tripped = await client.claimHeld({ config, hold: claimable.address });
    assert.equal(tripped.decision, "hold");
    assert.deepEqual(names(tripped.events), ["limitTripped", "paused"]);

    client.advanceClock(2 * H); // the window frees up and the auto-trip ends
    const claimed = await client.claimHeld({ config, hold: claimable.address });
    assert.equal(claimed.decision, "allow");
    assert.deepEqual(names(claimed.events), [
      "holdResolved",
      "outflowRecorded",
    ]);
    assert.equal(
      await client.getTokenBalance(
        walletTokenAccount(W.user.address, TEST_VAULT.mint),
      ),
      usdc(185_500),
    );
    await rejects(
      client.claimHeld({ config, hold: claimable.address }),
      "HoldInvalidState",
    );
  });

  it("refuses early, frozen and other people's claims", async () => {
    const holds = await client.listHolds(config);
    const waiting = holds.find((h) => h.account.amount === usdc(250_000))!;
    const frozen = holds.find((h) => h.account.status === "frozen")!;
    await rejects(
      client.claimHeld({ config, hold: waiting.address }),
      "HoldNotReleased",
    );
    client.setWallet(W.user2.address);
    await rejects(
      client.claimHeld({ config, hold: frozen.address }),
      "HoldFrozen",
    );
    await rejects(
      client.claimHeld({ config, hold: waiting.address }),
      "Unauthorized",
    );
  });

  it("lets the guardian freeze and the admin reject", async () => {
    const waiting = (await client.listHolds(config, { status: "queued" }))[0];
    await rejects(
      client.freezeHeld({ config, hold: waiting.address }),
      "Unauthorized",
    );

    client.setWallet(W.guardian.address);
    const frozen = await client.freezeHeld({ config, hold: waiting.address });
    assert.deepEqual(names(frozen.events), ["holdFrozen"]);
    await rejects(
      client.freezeHeld({ config, hold: waiting.address }),
      "HoldInvalidState",
    );
    await rejects(
      client.rejectHeld({ config, hold: waiting.address }),
      "Unauthorized",
    );

    client.setWallet(W.admin.address);
    const rejected = await client.rejectHeld({ config, hold: waiting.address });
    assert.deepEqual(rejected.events[0].data, {
      config,
      hold: waiting.address,
      outcome: 2,
    });
    const position = await client.getPosition(vault, W.user.address);
    assert.equal(position?.amount, usdc(439_500));
    assert.equal(position?.held, usdc(120_000));
  });
});

describe("pause rules", () => {
  it("enforces the guardian's cooldown, length cap, renewals and budget", async () => {
    client.setWallet(W.guardian.address);
    const withdraw = scopeMask(S.withdraw);
    const borrow = scopeMask(S.borrow);
    await rejects(
      client.pause({ config, scopes: withdraw, duration: H, reason: 0 }),
      "GuardianCooldown",
    );
    await rejects(
      client.pause({ config, scopes: withdraw, duration: 25 * H, reason: 0 }),
      "PauseTooLong",
    );
    await rejects(
      client.pause({
        config,
        scopes: scopeMask(S.repay),
        duration: H,
        reason: 0,
      }),
      "ScopeUnpausable",
    );

    const renewed = await client.renewPause({ config, scopes: borrow });
    assert.equal(dataOf(renewed.events, "pauseRenewed").renewals, 1);
    await client.renewPause({ config, scopes: borrow });
    await rejects(
      client.renewPause({ config, scopes: borrow }),
      "RenewCapReached",
    );
    await rejects(
      client.renewPause({ config, scopes: withdraw }),
      "ScopeNotPaused",
    );
    // Budget: 6h + 24h + 24h used of 96h.
    assert.equal(
      (await client.getGuardianLedger(config, W.guardian.address))?.account
        .pauseSecsUsed,
      54 * H,
    );

    await client.unpause({ config, scopes: borrow });
    assert.equal(
      (await client.getPauseState(config))?.account.active.length,
      0,
    );

    // Off cooldown (ends 6h after the latest scheduled end, 52h from now).
    client.advanceClock(59 * H);
    await client.pause({
      config,
      scopes: withdraw,
      duration: 24 * H,
      reason: 0,
    }); // 78h used
    await rejects(
      client.renewPause({ config, scopes: withdraw }),
      "PauseBudgetExhausted",
    );
  });

  it("lets the admin extend a pause so only the admin can lift it", async () => {
    client.setWallet(W.admin.address);
    const renewed = await client.renewPause({
      config,
      scopes: scopeMask(S.borrow),
    });
    assert.equal(dataOf(renewed.events, "pauseRenewed").by, W.admin.address);
    client.setWallet(W.guardian.address);
    await rejects(
      client.unpause({ config, scopes: scopeMask(S.borrow) }),
      "Unauthorized",
    );
  });

  it("refuses strangers and empty masks", async () => {
    await rejects(
      client.pause({
        config,
        scopes: scopeMask(S.borrow),
        duration: H,
        reason: 0,
      }),
      "Unauthorized",
    );
    client.setWallet(W.admin.address);
    await rejects(
      client.pause({ config, scopes: BigInt(0), duration: H, reason: 0 }),
      "InvalidScope",
    );
    await rejects(
      client.pause({
        config,
        scopes: scopeMask(S.borrow),
        duration: 0,
        reason: 0,
      }),
      "InvalidDuration",
    );
  });

  it("removes a guardian at once", async () => {
    client.setWallet(W.admin.address);
    const removed = await client.removeGuardian({
      config,
      guardian: W.guardian.address,
    });
    assert.deepEqual(names(removed.events), ["guardianRemoved"]);
    await rejects(
      client.removeGuardian({ config, guardian: W.guardian.address }),
      "GuardianNotFound",
    );
    client.setWallet(W.guardian.address);
    await rejects(
      client.unpause({ config, scopes: scopeMask(S.borrow) }),
      "Unauthorized",
    );
  });
});

describe("timelocked changes", () => {
  it("executes a change only after the timelock", async () => {
    const [change] = await client.listPendingChanges(config);
    await rejects(
      client.executeConfig({ config, change: change.address }),
      "TimelockActive",
    );
    client.advanceClock(28 * H);
    const done = await client.executeConfig({ config, change: change.address });
    assert.deepEqual(names(done.events), ["configChangeExecuted"]);
    const [limiter] = await client.listFlowLimiters(config);
    assert.equal(limiter.account.capAbsolute, usdc(250_000));
    await rejects(
      client.executeConfig({ config, change: change.address }),
      "NotExecutable",
    );
  });

  it("lets the guardian veto and the admin cancel", async () => {
    await rejects(
      client.proposeConfig({
        config,
        action: { kind: "setAdmin", admin: W.user.address },
      }),
      "Unauthorized",
    );
    client.setWallet(W.admin.address);
    const proposed = await client.proposeConfig({
      config,
      action: { kind: "addGuardian", guardian: W.user2.address },
    });
    assert.deepEqual(names(proposed.events), ["configChangeProposed"]);
    const { change } = dataOf(proposed.events, "configChangeProposed");

    client.setWallet(W.guardian.address);
    await client.vetoConfig({ config, change });
    client.advanceClock(48 * H);
    await rejects(client.executeConfig({ config, change }), "Vetoed");

    client.setWallet(W.admin.address);
    const other = await client.proposeConfig({
      config,
      action: { kind: "setAdmin", admin: W.user.address },
    });
    const otherChange = dataOf(other.events, "configChangeProposed").change;
    await client.cancelConfig({ config, change: otherChange });
    const left = await client.listPendingChanges(config);
    assert.ok(!left.some((c) => c.address === otherChange));
  });

  it("releases a frozen hold through the timelock; the claim isn't capped again", async () => {
    const frozen = (await client.listHolds(config, { status: "frozen" }))[0];
    client.setWallet(W.admin.address);
    const proposed = await client.releaseHeld({ config, hold: frozen.address });
    const { change } = dataOf(proposed.events, "configChangeProposed");
    client.advanceClock(48 * H);
    client.setWallet(W.user.address); // anyone can execute
    const executed = await client.executeConfig({ config, change });
    assert.deepEqual(names(executed.events), [
      "configChangeExecuted",
      "holdResolved",
    ]);

    client.setWallet(W.user2.address);
    const claimed = await client.claimHeld({ config, hold: frozen.address });
    assert.equal(claimed.decision, "allow");
  });
});

describe("setup on an empty chain", () => {
  it("registers a protocol and its limiter with the program's checks", async () => {
    client = makeClient(false);
    assert.deepEqual(await client.listConfigs(), []);
    const args = {
      protectedProgram: TEST_VAULT.program,
      admin: W.admin.address,
      guardians: [W.guardian.address],
      unpausableMask: scopeMask(S.repay),
      timelockSecs: null,
    };
    await rejects(client.initializeConfig(args), "Unauthorized");
    client.setWallet(W.admin.address);
    await rejects(
      client.initializeConfig({ ...args, timelockSecs: H }),
      "InvalidTimelock",
    );
    const created = await client.initializeConfig(args);
    assert.deepEqual(names(created.events), ["configInitialized"]);
    await rejects(client.initializeConfig(args), "AccountAlreadyInUse");

    const cfg = (await client.getConfig(TEST_VAULT.program))!;
    const limiterArgs = {
      config: cfg.address,
      mint: TEST_VAULT.mint,
      vault: TEST_VAULT.tokenAccount,
      scope: S.withdraw,
      capAbsolute: usdc(100),
      capBpsOfVault: 0,
      largeThreshold: usdc(50),
      largeThresholdBps: 0,
      windowSecs: null,
      holdSecs: null,
      autoTripSecs: null,
      instantAllowance: null,
      screenSecs: null,
    };
    await rejects(
      client.initFlowLimiter({ ...limiterArgs, scope: S.repay }),
      "ScopeUnpausable",
    );
    await rejects(
      client.initFlowLimiter({ ...limiterArgs, windowSecs: 5 }),
      "InvalidLimiterConfig",
    );
    await client.initFlowLimiter(limiterArgs);
    assert.equal((await client.listFlowLimiters(cfg.address)).length, 1);
    await rejects(client.initFlowLimiter(limiterArgs), "AccountAlreadyInUse");
  });
});

describe("demo programs", () => {
  it("lets a wallet register a program it deployed, with a limiter", async () => {
    const me = "Regist3rMe11111111111111111111111111111111";
    client.setWallet(me);
    const demo = await client.createDemoProgram();
    const args = {
      protectedProgram: demo.program,
      admin: me,
      guardians: [W.guardian.address],
      unpausableMask: BigInt(0),
      timelockSecs: 36 * H,
    };
    client.setWallet(W.user.address); // not the upgrade authority
    await rejects(
      client.initializeConfig({ ...args, admin: W.user.address }),
      "Unauthorized",
    );
    client.setWallet(me);
    await client.initializeConfig(args);
    const cfg = (await client.getConfig(demo.program))!;
    assert.equal(cfg.account.timelockSecs, 36 * H);
    await client.initFlowLimiter({
      config: cfg.address,
      mint: demo.mint,
      vault: demo.vault,
      scope: 1,
      capAbsolute: usdc(50_000),
      capBpsOfVault: 1000,
      largeThreshold: usdc(20_000),
      largeThresholdBps: 0,
      windowSecs: null,
      holdSecs: null,
      autoTripSecs: null,
      instantAllowance: null,
      screenSecs: null,
    });
    assert.equal((await client.listFlowLimiters(cfg.address)).length, 1);
    assert.equal((await client.listConfigs()).length, 2);
  });
});

describe("simulated outage", () => {
  it("fails every read while on, and recovers when off", async () => {
    client.setOutage(true);
    await rejects(client.listHolds(config), "NetworkUnavailable");
    await rejects(client.getClock(), "NetworkUnavailable");
    client.setOutage(false);
    assert.equal((await client.listHolds(config)).length, 3);
  });
});

describe("test-token faucet", () => {
  it("funds a brand-new wallet so it can deposit", async () => {
    const newcomer = "NewJudgeWa11et1111111111111111111111111111";
    client.setWallet(newcomer);
    await rejects(
      client.deposit({ vault, amount: usdc(1) }),
      "InsufficientFunds",
    );
    await client.requestTestTokens(usdc(10_000));
    assert.equal(
      await client.getTokenBalance(
        walletTokenAccount(newcomer, TEST_VAULT.mint),
      ),
      usdc(10_000),
    );
    await client.deposit({ vault, amount: usdc(2_500) });
    assert.equal(
      (await client.getPosition(vault, newcomer))?.amount,
      usdc(2_500),
    );
    client.setWallet(null);
    await rejects(client.requestTestTokens(usdc(1)), "WalletNotConnected");
  });
});

describe("monitor and change notifications", () => {
  it("acknowledges an incident", async () => {
    const [open] = await client.listIncidents("open");
    const acked = await client.ackIncident(open.id, { by: "guardian" });
    assert.equal(acked.status, "acked");
    assert.equal(acked.acked_by, "guardian");
  });

  it("notifies subscribers after writes and clock changes", async () => {
    let calls = 0;
    const stop = client.subscribe(() => calls++);
    await client.withdraw({ vault, amount: usdc(10) });
    client.advanceClock(60);
    assert.equal(calls, 2);
    stop();
    client.advanceClock(60);
    assert.equal(calls, 2);
  });

  it("resets to the demo state", async () => {
    await client.withdraw({ vault, amount: usdc(10) });
    client.advanceClock(H);
    client.reset();
    assert.equal(await client.getClock(), T);
    assert.equal(
      (await client.getPosition(vault, W.user.address))?.amount,
      usdc(189_500),
    );
  });
});
