// Phase 4 on the real validator: everything that doesn't need the clock to
// move. The "after the timelock" cases (execute succeeds, a vetoed change
// still can't run, a released hold pays out) are in tests/timelock-warp.ts,
// which runs the same programs in LiteSVM with a settable clock.

import { BN } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { expect } from "chai";
import {
  admin,
  breakglass,
  cancelChange,
  claimHeld,
  configPda,
  createVault,
  deposit,
  ensureConfig,
  executeChange,
  expectError,
  freezeHeld,
  fund,
  guardians,
  holdPda,
  HOUR,
  limiterSettings,
  nextNonce,
  onlyEvent,
  propose,
  tightenLimits,
  VaultFixture,
  vetoChange,
  waitPast,
  withdraw,
} from "./helpers";

const guardian = guardians[2];
const TIMELOCK = 48 * HOUR;

describe("timelock", () => {
  const stranger = Keypair.generate();
  let v: VaultFixture;

  before(async () => {
    await ensureConfig();
    await fund(stranger.publicKey);
    v = await createVault({
      limiter: {
        capAbsolute: new BN(1_000),
        largeThreshold: new BN(400),
        holdSecs: new BN(2),
      },
    });
    await deposit(v, 5_000);
  });

  it("raising the cap is queued: executing right away fails with TimelockActive", async () => {
    const before = await limiterSettings(v.limiter);
    const params = { ...before, capAbsolute: new BN(5_000) };
    const idBefore = (await breakglass.account.protocolConfig.fetch(configPda))
      .nextChangeId;
    const { sig, pending } = await propose(admin, {
      raiseLimits: { mint: v.mint, params },
    });

    const ev = await onlyEvent(sig, "ConfigChangeProposed");
    expect(ev.change.toBase58()).to.equal(pending.toBase58());
    expect(ev.actionKind).to.equal(0);
    const p = await breakglass.account.pendingConfig.fetch(pending);
    expect(p.id.toString()).to.equal(idBefore.toString());
    expect(p.proposedBy.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(p.executableAt.toNumber() - p.proposedAt.toNumber()).to.equal(
      TIMELOCK,
    );
    expect(ev.executableAt.toNumber()).to.equal(p.executableAt.toNumber());
    expect(p.action.raiseLimits.params.capAbsolute.toNumber()).to.equal(5_000);
    expect(
      (
        await breakglass.account.protocolConfig.fetch(configPda)
      ).nextChangeId.toString(),
    ).to.equal(idBefore.addn(1).toString());

    await expectError(
      executeChange(pending, { flowLimiter: v.limiter }),
      "TimelockActive",
    );
    expect((await limiterSettings(v.limiter)).capAbsolute.toNumber()).to.equal(
      1_000,
    );
  });

  it("a guardian veto blocks the change; a second veto or a stranger's veto fails", async () => {
    const { pending } = await propose(admin, {
      addGuardian: { guardian: Keypair.generate().publicKey },
    });
    await expectError(vetoChange(stranger, pending), "Unauthorized");
    const sig = await vetoChange(guardian, pending);
    const ev = await onlyEvent(sig, "ConfigChangeVetoed");
    expect(ev.by.toBase58()).to.equal(guardian.publicKey.toBase58());
    expect(
      (await breakglass.account.pendingConfig.fetch(pending)).vetoed,
    ).to.equal(true);

    await expectError(vetoChange(guardian, pending), "Vetoed");
    await expectError(executeChange(pending), "Vetoed");
  });

  it("the admin can cancel a pending change; it can never run after that", async () => {
    const { pending } = await propose(admin, {
      setAdmin: { admin: Keypair.generate().publicKey },
    });
    await expectError(cancelChange(guardian, pending), "Unauthorized");
    const sig = await cancelChange(admin, pending);
    await onlyEvent(sig, "ConfigChangeCancelled");
    await expectError(executeChange(pending), "ChangeClosed");
    await expectError(vetoChange(guardian, pending), "ChangeClosed");
    await expectError(cancelChange(admin, pending), "ChangeClosed");
  });

  it("lowering the cap applies in the same transaction (no timelock)", async () => {
    const before = await limiterSettings(v.limiter);
    const sig = await tightenLimits(admin, v.limiter, {
      ...before,
      capAbsolute: new BN(800),
      largeThreshold: new BN(300),
    });
    const ev = await onlyEvent(sig, "LimitsTightened");
    expect(ev.mint.toBase58()).to.equal(v.mint.toBase58());
    const after = await limiterSettings(v.limiter);
    expect(after.capAbsolute.toNumber()).to.equal(800);
    expect(after.largeThreshold.toNumber()).to.equal(300);
  });

  it("tighten_limits refuses anything that loosens (NotTightening), and is admin only", async () => {
    const cur = await limiterSettings(v.limiter);
    await expectError(
      tightenLimits(admin, v.limiter, {
        ...cur,
        capAbsolute: cur.capAbsolute.addn(1),
      }),
      "NotTightening",
    );
    await expectError(
      tightenLimits(admin, v.limiter, {
        ...cur,
        capAbsolute: new BN(1),
        holdSecs: new BN(1),
      }),
      "NotTightening",
    );
    await expectError(
      tightenLimits(guardian, v.limiter, { ...cur, capAbsolute: new BN(1) }),
      "Unauthorized",
    );
  });

  it("releasing a frozen hold only goes through the timelock", async () => {
    const nonce = nextNonce();
    await withdraw(v, 500, nonce); // >= threshold: held
    const hold = holdPda(v.user.publicKey, nonce);
    await freezeHeld(guardian, hold);
    const h = await breakglass.account.pendingWithdrawal.fetch(hold);
    await waitPast(h.releaseAt.toNumber());
    await expectError(claimHeld(v, hold), "HoldFrozen");

    const { pending } = await propose(admin, { releaseHeld: { hold } });
    await expectError(executeChange(pending, { hold }), "TimelockActive");
    expect(
      (await breakglass.account.pendingWithdrawal.fetch(hold)).status,
    ).to.deep.equal({
      frozen: {},
    });
    await expectError(claimHeld(v, hold), "HoldFrozen");
  });

  it("neither a random signer nor a guardian can propose", async () => {
    const action = { addGuardian: { guardian: Keypair.generate().publicKey } };
    await expectError(propose(stranger, action), "Unauthorized");
    await expectError(propose(guardian, action), "Unauthorized");
  });

  it("bad proposals fail at propose time", async () => {
    await expectError(
      propose(admin, { addGuardian: { guardian: guardian.publicKey } }),
      "DuplicateGuardian",
    );
    const policy = (await breakglass.account.protocolConfig.fetch(configPda))
      .policy;
    await expectError(
      propose(admin, {
        changePolicy: {
          policy,
          unpausableMask: new BN(8),
          timelockSecs: new BN(HOUR),
        },
      }),
      "InvalidTimelock",
    );
    await expectError(
      propose(admin, {
        changePolicy: {
          policy: { ...policy, maxGuardianPauseSecs: new BN(0) },
          unpausableMask: new BN(8),
          timelockSecs: new BN(TIMELOCK),
        },
      }),
      "InvalidPolicy",
    );
    const cur = await limiterSettings(v.limiter);
    await expectError(
      propose(admin, {
        raiseLimits: {
          mint: v.mint,
          params: { ...cur, capAbsolute: new BN(0) },
        },
      }),
      "InvalidLimiterConfig",
    );
  });
});
