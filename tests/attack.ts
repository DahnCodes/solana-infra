// Phase 3: zero-loss mode against a real bug.
//
// `yarn test:attack` builds test-vault with the `planted-bug` feature (withdraw
// skips the user-position check) and runs this file with PLANTED_BUG=1.
// A plain `anchor test` (safe build) runs the default-build cases instead.
//
// Scenarios (BUILD_PLAN Phase 3):
//   1. invariants on            -> over-position withdraws revert (InvariantViolated)
//   2. invariants off, screen-all -> every withdraw is queued; the guardian freezes them
//   3. both off (baseline)      -> the attacker gets at most the window cap

import { BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import {
  admin,
  breakglass,
  claimHeld,
  createVault,
  deposit,
  ensureConfig,
  expectError,
  freezeHeld,
  guardians,
  heldOf,
  holdPda,
  mask,
  newUser,
  nextNonce,
  positionOf,
  SCOPE,
  tokenBalance,
  unpause,
  VaultFixture,
  waitPast,
  withdraw,
} from "./helpers";

const PLANTED_BUG = process.env.PLANTED_BUG === "1";
const guardian = guardians[3];
const VICTIM_DEPOSIT = 10_000;
const ATTACKER_DEPOSIT = 100;

/** A vault with a victim's deposit and an attacker holding a small position. */
async function arena(opts: Parameters<typeof createVault>[0]) {
  const victim = await createVault(opts);
  await deposit(victim, VICTIM_DEPOSIT);
  const attacker = await newUser(victim);
  await deposit(attacker, ATTACKER_DEPOSIT);
  return { victim, attacker };
}

async function vaultBalance(v: VaultFixture) {
  return tokenBalance(v.vaultToken);
}

describe(`attack: planted bug (${
  PLANTED_BUG ? "planted-bug build" : "default build"
})`, () => {
  before(ensureConfig);

  if (!PLANTED_BUG) {
    it("default build: the bug isn't there, an over-position withdraw fails", async () => {
      const { attacker } = await arena({});
      const before = await vaultBalance(attacker);
      await expectError(withdraw(attacker, 1_000), "InsufficientPosition", {
        framework: true,
      });
      expect(await vaultBalance(attacker)).to.equal(before);
    });

    it("default build: a vault can't turn its invariants off", async () => {
      let err: any;
      try {
        await createVault({ invariantsOff: true });
      } catch (e) {
        err = e;
      }
      expect(String(err?.error?.errorCode?.code ?? err)).to.contain(
        "InvariantsRequired",
      );
    });
    return;
  }

  it("invariants on: over-position withdraws revert with InvariantViolated and the vault is unchanged", async () => {
    const { attacker } = await arena({
      limiter: {
        capAbsolute: new BN(1_000_000),
        largeThreshold: new BN(5_000),
      },
    });
    const before = await vaultBalance(attacker);

    // Allow path: would pay 1000 against a 100 position.
    await expectError(withdraw(attacker, 1_000), "InvariantViolated");
    // Hold path: would queue a 9000 hold against a 100 position.
    await expectError(withdraw(attacker, 9_000), "InvariantViolated");

    expect(await vaultBalance(attacker)).to.equal(before);
    expect(await positionOf(attacker)).to.equal(ATTACKER_DEPOSIT);
    expect(await heldOf(attacker)).to.equal(0);

    // Honest withdrawals still work under the same invariants.
    const bal = await tokenBalance(attacker.userToken);
    await withdraw(attacker, ATTACKER_DEPOSIT);
    expect(await tokenBalance(attacker.userToken)).to.equal(
      bal + BigInt(ATTACKER_DEPOSIT),
    );
  });

  it("invariants off, screen-all on: every attacker withdrawal is queued, the guardian freezes them all, the vault is unchanged", async () => {
    const { attacker } = await arena({
      invariantsOff: true,
      limiter: {
        capAbsolute: new BN(1_000_000),
        largeThreshold: new BN(1_000_000),
        instantAllowance: new BN(0),
        screenSecs: new BN(3),
      },
    });
    const before = await vaultBalance(attacker);

    const holds = [];
    for (let i = 0; i < 3; i++) {
      const nonce = nextNonce();
      await withdraw(attacker, 3_000, nonce); // 30x the attacker's position
      holds.push(holdPda(attacker.user.publicKey, nonce));
    }
    expect(await vaultBalance(attacker)).to.equal(before);

    let releaseAt = 0;
    for (const h of holds) {
      const hold = await breakglass.account.pendingWithdrawal.fetch(h);
      expect(hold.kind).to.deep.equal({ screen: {} });
      releaseAt = Math.max(releaseAt, hold.releaseAt.toNumber());
      await freezeHeld(guardian, h); // the guardian bot's job in Phase 6
    }

    await waitPast(releaseAt);
    for (const h of holds)
      await expectError(claimHeld(attacker, h), "HoldFrozen");
    expect(await vaultBalance(attacker)).to.equal(before);
  });

  it("both off (baseline): the attacker gets at most the window cap", async () => {
    const CAP = 1_000;
    const { attacker } = await arena({
      invariantsOff: true,
      limiter: { capAbsolute: new BN(CAP), largeThreshold: new BN(400) },
    });
    const vaultBefore = await vaultBalance(attacker);
    const walletBefore = await tokenBalance(attacker.userToken);

    // Drain in sub-threshold chunks until the gate stops it.
    let blocked = 0;
    for (let i = 0; i < 10; i++) {
      try {
        await withdraw(attacker, 300);
      } catch (e: any) {
        expect(String(e?.error?.errorCode?.code ?? e)).to.contain(
          "ScopePaused",
        );
        blocked++;
      }
    }
    const stolen = Number(
      (await tokenBalance(attacker.userToken)) - walletBefore,
    );

    expect(
      stolen,
      "the bug is real: more than the attacker's position",
    ).to.be.greaterThan(ATTACKER_DEPOSIT);
    expect(stolen, "bounded by the window cap").to.be.at.most(CAP);
    expect(Number(vaultBefore - (await vaultBalance(attacker)))).to.equal(
      stolen,
    );
    expect(blocked).to.be.greaterThan(0);

    await unpause(admin, mask(SCOPE.WITHDRAW));
  });
});
