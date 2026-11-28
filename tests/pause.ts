// Phase 1 acceptance tests: pauses, renewals, unpause rights, griefing limits.
// Every rule is also unit-tested in programs/breakglass/src/pause_logic.rs,
// including the ones that need days of clock time (budget, period rollover).

import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  admin,
  breakglass,
  configPda,
  createVault,
  deposit,
  ensureConfig,
  expectError,
  fund,
  guardians,
  HOUR,
  ledgerPda,
  mask,
  onlyEvent,
  pause,
  pausePda,
  removeGuardian,
  renewPause,
  SCOPE,
  tokenBalance,
  unpause,
  VaultFixture,
  waitPast,
  withdraw,
} from "./helpers";

const [g0, g1, g2, g3, g4] = guardians;
const W = mask(SCOPE.WITHDRAW);
const D = mask(SCOPE.DEPOSIT);
/** A scope test-vault doesn't use, so long pauses on it don't block other tests. */
const SPARE = 10;

async function activeFor(scope: number) {
  const s = await breakglass.account.pauseState.fetch(pausePda);
  return s.active.filter((p) => p.scope === scope);
}

describe("pause", () => {
  let vault: VaultFixture;
  const stranger = Keypair.generate();

  before(async () => {
    await ensureConfig();
    await fund(stranger.publicKey);
    vault = await createVault();
    await deposit(vault, 500_000);
  });

  it("guardian pauses WITHDRAW: withdraw fails, then works again after expiry with no unpause", async () => {
    const sig = await pause(g0, W, 4, 42);
    const ev = await onlyEvent(sig, "Paused");
    expect(ev.scopesMask.toString()).to.equal(W.toString());
    expect(ev.by.toBase58()).to.equal(g0.publicKey.toBase58());
    expect(ev.kind).to.equal(0);
    expect(ev.reason).to.equal(42);
    const until = ev.pausedUntil.toNumber();

    const [entry] = await activeFor(SCOPE.WITHDRAW);
    expect(entry.kind).to.deep.equal({ guardian: {} });
    expect(entry.pausedUntil.toNumber()).to.equal(until);

    const ledger = await breakglass.account.guardianLedger.fetch(
      ledgerPda(g0.publicKey),
    );
    expect(ledger.guardian.toBase58()).to.equal(g0.publicKey.toBase58());
    expect(ledger.config.toBase58()).to.equal(configPda.toBase58());
    expect(ledger.pauseSecsUsed.toNumber()).to.equal(4);
    expect(ledger.lastPauseEnd.toNumber()).to.equal(until);

    await expectError(withdraw(vault, 10), "ScopePaused");

    await waitPast(until);
    const before = await tokenBalance(vault.userToken);
    await withdraw(vault, 10);
    expect(await tokenBalance(vault.userToken)).to.equal(before + 10n);
  });

  it("guardian pausing again within the cooldown fails with GuardianCooldown", async () => {
    // g0's pause ended moments ago; the 6h cooldown applies to every scope.
    await expectError(pause(g0, W, 10), "GuardianCooldown");
    await expectError(pause(g0, mask(SCOPE.BORROW), 10), "GuardianCooldown");
  });

  it("guardian pause longer than 24h fails with PauseTooLong", async () => {
    await expectError(pause(g1, W, 25 * HOUR), "PauseTooLong");
    // (g0's expired entry may still be listed: expiry is lazy, pruned on the next write.)
    const byG1 = (await activeFor(SCOPE.WITHDRAW)).filter((p) =>
      p.pausedBy.equals(g1.publicKey),
    );
    expect(byG1).to.have.length(0);
  });

  it("a paused DEPOSIT blocks deposits, and the guardian can lift its own pause", async () => {
    await pause(g1, D, HOUR, 1);
    await expectError(deposit(vault, 10), "ScopePaused");

    const sig = await unpause(g1, D);
    const ev = await onlyEvent(sig, "Unpaused");
    expect(ev.scopesMask.toString()).to.equal(D.toString());
    expect(ev.by.toBase58()).to.equal(g1.publicKey.toBase58());
    await deposit(vault, 10);

    // Lifting early gives no cooldown credit.
    await expectError(pause(g1, D, 10), "GuardianCooldown");
  });

  it("guardian renews twice, the third renewal fails with RenewCapReached, the admin extends past it", async () => {
    const S = mask(SPARE);
    const ev0 = await onlyEvent(await pause(g2, S, 60), "Paused");
    let until = ev0.pausedUntil.toNumber();

    for (const n of [1, 2]) {
      const ev = await onlyEvent(await renewPause(g2, S), "PauseRenewed");
      expect(ev.renewals).to.equal(n);
      expect(ev.pausedUntil.toNumber()).to.equal(until + 24 * HOUR);
      until = ev.pausedUntil.toNumber();
    }
    await expectError(renewPause(g2, S), "RenewCapReached");

    const ev = await onlyEvent(await renewPause(admin, S), "PauseRenewed");
    expect(ev.by.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(ev.renewals).to.equal(3);
    expect(ev.pausedUntil.toNumber()).to.equal(until + 24 * HOUR);

    // The extension belongs to the admin, so the guardian can't lift the scope any more.
    const kinds = (await activeFor(SPARE))
      .map((p) => Object.keys(p.kind)[0])
      .sort();
    expect(kinds).to.deep.equal(["admin", "guardian"]);
    await expectError(unpause(g2, S), "Unauthorized");

    await unpause(admin, S);
    expect(await activeFor(SPARE)).to.have.length(0);
  });

  it("guardian can't unpause an admin pause (Unauthorized); the admin can", async () => {
    const ev = await onlyEvent(await pause(admin, W, HOUR, 7), "Paused");
    expect(ev.kind).to.equal(2);

    await expectError(unpause(g3, W), "Unauthorized");
    await expectError(withdraw(vault, 10), "ScopePaused");

    await unpause(admin, W);
    await withdraw(vault, 10);
  });

  it("pausing an unpausable scope fails with ScopeUnpausable", async () => {
    await expectError(pause(g3, mask(SCOPE.REPAY), 10), "ScopeUnpausable");
    await expectError(
      pause(admin, mask(SCOPE.REPAY, SCOPE.WITHDRAW), 10),
      "ScopeUnpausable",
    );
    expect(await activeFor(SCOPE.REPAY)).to.have.length(0);
    await withdraw(vault, 10); // WITHDRAW wasn't paused by the failed call either
  });

  it("a random keypair gets Unauthorized for every pause instruction", async () => {
    await expectError(pause(stranger, W, 10), "Unauthorized");
    await expectError(renewPause(stranger, W), "Unauthorized");
    await expectError(unpause(stranger, W), "Unauthorized");
    await expectError(removeGuardian(stranger, g4.publicKey), "Unauthorized");
  });

  it("a guardian can't remove a guardian", async () => {
    await expectError(removeGuardian(g3, g4.publicKey), "Unauthorized");
  });

  it("rejects empty masks, non-positive durations and unpausing what isn't paused", async () => {
    await expectError(pause(admin, mask(), 10), "InvalidScope");
    await expectError(pause(admin, W, 0), "InvalidDuration");
    await expectError(pause(g3, W, -1), "InvalidDuration");
    await expectError(unpause(admin, mask(SPARE + 1)), "ScopeNotPaused");
    await expectError(renewPause(g3, mask(SPARE + 1)), "ScopeNotPaused");
  });

  it("admin removes a guardian: its pause then fails with Unauthorized", async () => {
    const ev = await onlyEvent(
      await removeGuardian(admin, g4.publicKey),
      "GuardianRemoved",
    );
    expect(ev.guardian.toBase58()).to.equal(g4.publicKey.toBase58());

    const config = await breakglass.account.protocolConfig.fetch(configPda);
    expect(config.guardians.map((g) => g.toBase58())).to.not.include(
      g4.publicKey.toBase58(),
    );
    expect(config.guardians).to.have.length(4);

    await expectError(pause(g4, W, 10), "Unauthorized");
    await expectError(removeGuardian(admin, g4.publicKey), "GuardianNotFound");
  });
});
