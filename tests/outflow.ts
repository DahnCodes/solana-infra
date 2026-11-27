// Phase 2 acceptance tests: the outflow gate (Allow / Hold / Deny), held
// withdrawals, the window cap and auto-trip, and fail-closed account checks.
// The limiter math itself is unit- and property-tested in
// programs/breakglass/src/limiter.rs (`cargo test -p breakglass`).

import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import {
  admin,
  breakglass,
  claimHeld,
  configPda,
  connection,
  createVault,
  deposit,
  ensureConfig,
  eventAuthorityPda,
  eventsOf,
  expectError,
  freezeHeld,
  heldOf,
  fund,
  guardians,
  holdPda,
  initConfig,
  initLimiter,
  limiterParams,
  mask,
  nextNonce,
  onlyEvent,
  pausePda,
  positionOf,
  provider,
  rejectHeld,
  SCOPE,
  testVault,
  tokenBalance,
  unpause,
  VaultFixture,
  waitPast,
  withdraw,
  withdrawAccounts,
  withdrawIx,
} from "./helpers";

const W = mask(SCOPE.WITHDRAW);
const FAKE_PAUSE_STATE = new PublicKey(
  "FakePauseState11111111111111111111111111111",
);
/** g4 is removed in pause.ts; g3 never pauses, so it's free for holds. */
const guardian = guardians[3];

/** cap 1000 per window, threshold 400, short holds so tests can claim. */
const TIGHT = {
  capAbsolute: new BN(1_000),
  largeThreshold: new BN(400),
  holdSecs: new BN(3),
};

async function names(sig: string) {
  return (await eventsOf(sig)).map((e) => e.name);
}

async function withdrawHeld(v: VaultFixture, amount: number) {
  const nonce = nextNonce();
  const sig = await withdraw(v, amount, nonce);
  return { sig, nonce, hold: holdPda(v.user.publicKey, nonce) };
}

async function sendAll(v: VaultFixture, amounts: number[]) {
  const tx = new Transaction();
  for (const a of amounts) tx.add(await withdrawIx(v, a, nextNonce()));
  return provider.sendAndConfirm(tx, [v.user], { commitment: "confirmed" });
}

async function autoTrips() {
  const s = await breakglass.account.pauseState.fetch(pausePda);
  const now = Math.floor(Date.now() / 1000) - 5;
  return s.active.filter(
    (p) => p.kind.autoTrip !== undefined && p.pausedUntil.toNumber() > now,
  );
}

describe("outflow", () => {
  const stranger = Keypair.generate();
  let a: VaultFixture;

  before(async () => {
    await ensureConfig();
    await fund(stranger.publicKey);
    a = await createVault({ limiter: TIGHT });
    await deposit(a, 5_000);
  });

  it("a small withdraw is allowed: funds arrive and OutflowRecorded is emitted", async () => {
    const before = await tokenBalance(a.userToken);
    const { sig, hold } = await withdrawHeld(a, 100);
    expect(await tokenBalance(a.userToken)).to.equal(before + 100n);
    expect(await positionOf(a)).to.equal(4_900);

    const ev = await onlyEvent(sig, "OutflowRecorded");
    expect(ev.amount.toNumber()).to.equal(100);
    expect(ev.windowTotal.toNumber()).to.equal(100);
    expect(ev.windowCap.toNumber()).to.equal(1_000);
    expect(ev.owner.toBase58()).to.equal(a.user.publicKey.toBase58());
    expect(ev.mint.toBase58()).to.equal(a.mint.toBase58());
    expect(await connection.getAccountInfo(hold)).to.equal(null);
  });

  it("a large withdraw is held: no funds move, early claim fails, claim after release_at works", async () => {
    const before = await tokenBalance(a.userToken);
    const { sig, hold, nonce } = await withdrawHeld(a, 500);
    expect(await tokenBalance(a.userToken)).to.equal(before);
    expect(await positionOf(a)).to.equal(4_400);
    expect(await heldOf(a)).to.equal(500); // still owed, now as a hold

    const ev = await onlyEvent(sig, "LargeWithdrawalQueued");
    expect(ev.hold.toBase58()).to.equal(hold.toBase58());
    expect(ev.amount.toNumber()).to.equal(500);

    const h = await breakglass.account.pendingWithdrawal.fetch(hold);
    expect(h.status).to.deep.equal({ queued: {} });
    expect(h.kind).to.deep.equal({ large: {} });
    expect(h.amount.toNumber()).to.equal(500);
    expect(h.nonce.toString()).to.equal(nonce.toString());
    expect(h.owner.toBase58()).to.equal(a.user.publicKey.toBase58());
    expect(h.scope).to.equal(SCOPE.WITHDRAW);
    expect(h.releaseAt.toNumber()).to.equal(ev.releaseAt.toNumber());

    await expectError(claimHeld(a, hold), "HoldNotReleased");

    await waitPast(h.releaseAt.toNumber());
    const claim = await claimHeld(a, hold);
    expect(await tokenBalance(a.userToken)).to.equal(before + 500n);
    expect(await heldOf(a)).to.equal(0);
    expect(await names(claim)).to.deep.equal([
      "holdResolved",
      "outflowRecorded",
    ]);
    const out = (await eventsOf(claim))[1].data;
    expect(out.windowTotal.toNumber()).to.equal(600); // 100 + 500: claims count
    expect(
      (await breakglass.account.pendingWithdrawal.fetch(hold)).status,
    ).to.deep.equal({
      claimed: {},
    });

    await expectError(claimHeld(a, hold), "HoldInvalidState");
  });

  it("a frozen hold can never be claimed; reject_held returns the amount to the position", async () => {
    const { hold } = await withdrawHeld(a, 450);
    expect(await positionOf(a)).to.equal(3_950);

    await expectError(freezeHeld(stranger, hold), "Unauthorized");
    const sig = await freezeHeld(guardian, hold);
    const ev = await onlyEvent(sig, "HoldFrozen");
    expect(ev.by.toBase58()).to.equal(guardian.publicKey.toBase58());
    await expectError(freezeHeld(guardian, hold), "HoldInvalidState");

    const h = await breakglass.account.pendingWithdrawal.fetch(hold);
    await waitPast(h.releaseAt.toNumber());
    await expectError(claimHeld(a, hold), "HoldFrozen");

    // Only the Breakglass admin can reject, and only through the protocol.
    await expectError(rejectHeld(guardian, a, hold), "Unauthorized");
    const before = await tokenBalance(a.userToken);
    const rej = await rejectHeld(admin, a, hold);
    const res = await onlyEvent(rej, "HoldResolved");
    expect(res.outcome).to.equal(2);
    expect(await positionOf(a)).to.equal(4_400);
    expect(await heldOf(a)).to.equal(0);
    expect(await tokenBalance(a.userToken)).to.equal(before);

    await expectError(claimHeld(a, hold), "HoldInvalidState");
    await expectError(rejectHeld(admin, a, hold), "HoldInvalidState");
  });

  it("many small withdraws in one transaction cross the cap: the crossing call is held and the scope auto-trips", async () => {
    const b = await createVault({ limiter: TIGHT });
    await deposit(b, 5_000);
    const before = await tokenBalance(b.userToken);

    // 300 x 4: 300, 600, 900 allowed; 1200 > 1000 is held and trips.
    const sig = await sendAll(b, [300, 300, 300, 300]);
    expect(await tokenBalance(b.userToken)).to.equal(before + 900n);
    expect(await names(sig)).to.deep.equal([
      "outflowRecorded",
      "outflowRecorded",
      "outflowRecorded",
      "limitTripped",
      "paused",
      "limitHoldQueued",
    ]);
    const evs = await eventsOf(sig);
    const trip = evs[3].data;
    expect(trip.windowTotal.toNumber()).to.equal(900);
    expect(trip.windowCap.toNumber()).to.equal(1_000);
    const paused = evs[4].data;
    expect(paused.kind).to.equal(1);
    expect(paused.by.toBase58()).to.equal(b.limiter.toBase58());
    const held = await breakglass.account.pendingWithdrawal.fetch(
      evs[5].data.hold,
    );
    expect(held.kind).to.deep.equal({ limit: {} });
    expect(held.amount.toNumber()).to.equal(300);

    const trips = await autoTrips();
    expect(trips.map((p) => p.scope)).to.deep.equal([SCOPE.WITHDRAW]);

    // The whole scope is closed, for every mint, and only the admin can reopen it.
    await expectError(withdraw(a, 10), "ScopePaused");
    await expectError(unpause(guardian, W), "Unauthorized");
    await unpause(admin, W);
    await withdraw(a, 10);
  });

  it("a transaction that keeps withdrawing after the trip reverts entirely", async () => {
    const d = await createVault({ limiter: TIGHT });
    await deposit(d, 5_000);
    const before = await tokenBalance(d.userToken);
    await expectError(sendAll(d, [300, 300, 300, 300, 300]), "ScopePaused");
    expect(await tokenBalance(d.userToken)).to.equal(before);
    const l = await breakglass.account.flowLimiter.fetch(d.limiter);
    expect(l.buckets.every((x) => x.isZero())).to.equal(true);
    expect(await autoTrips()).to.have.length(0);
  });

  it("a claim that would cross the cap trips the scope instead of paying out", async () => {
    const c = await createVault({ limiter: TIGHT });
    await deposit(c, 5_000);
    const { hold } = await withdrawHeld(c, 600);
    await withdraw(c, 300);
    await withdraw(c, 300); // window 600
    const h = await breakglass.account.pendingWithdrawal.fetch(hold);
    await waitPast(h.releaseAt.toNumber());

    const before = await tokenBalance(c.userToken);
    const sig = await claimHeld(c, hold);
    expect(await names(sig)).to.deep.equal(["limitTripped", "paused"]);
    expect(await tokenBalance(c.userToken)).to.equal(before);
    expect(
      (await breakglass.account.pendingWithdrawal.fetch(hold)).status,
    ).to.deep.equal({
      queued: {},
    });
    await unpause(admin, W);
  });

  it("screen-all (instant allowance 0) holds even a tiny withdraw for screen_secs", async () => {
    const e = await createVault({
      limiter: { ...TIGHT, instantAllowance: new BN(0), screenSecs: new BN(3) },
    });
    await deposit(e, 5_000);
    const before = await tokenBalance(e.userToken);
    const { sig, hold } = await withdrawHeld(e, 1);
    const ev = await onlyEvent(sig, "WithdrawalScreenQueued");
    expect(await tokenBalance(e.userToken)).to.equal(before);
    const h = await breakglass.account.pendingWithdrawal.fetch(hold);
    expect(h.kind).to.deep.equal({ screen: {} });
    await waitPast(ev.releaseAt.toNumber());
    await claimHeld(e, hold);
    expect(await tokenBalance(e.userToken)).to.equal(before + 1n);
  });

  describe("fails closed", () => {
    it("a fake PauseState (valid layout, wrong owner) is rejected", async () => {
      const info = await connection.getAccountInfo(FAKE_PAUSE_STATE);
      expect(info, "fixture loaded by Anchor.toml").to.not.equal(null);
      const nonce = nextNonce();
      const p = testVault.methods
        .withdraw(new BN(10), nonce)
        .accountsPartial({
          ...withdrawAccounts(a, nonce),
          bgPauseState: FAKE_PAUSE_STATE,
        })
        .signers([a.user])
        .rpc();
      await expectError(p, "AccountOwnedByWrongProgram", { framework: true });
    });

    it("the real PauseState of the wrong seeds (another Breakglass account) is rejected", async () => {
      const nonce = nextNonce();
      const p = testVault.methods
        .withdraw(new BN(10), nonce)
        .accountsPartial({
          ...withdrawAccounts(a, nonce),
          bgPauseState: a.limiter,
        })
        .signers([a.user])
        .rpc();
      await expectError(p, "AccountDiscriminatorMismatch", { framework: true });
    });

    it("another mint's limiter is rejected (WrongVault)", async () => {
      const other = await createVault();
      const nonce = nextNonce();
      const p = testVault.methods
        .withdraw(new BN(10), nonce)
        .accountsPartial({
          ...withdrawAccounts(a, nonce),
          bgFlowLimiter: other.limiter,
        })
        .signers([a.user])
        .rpc();
      await expectError(p, "WrongVault");
    });

    it("a hold account that doesn't match its seeds is rejected (WrongHold)", async () => {
      const nonce = nextNonce();
      const p = testVault.methods
        .withdraw(new BN(500), nonce)
        .accountsPartial({
          ...withdrawAccounts(a, nonce),
          bgHold: Keypair.generate().publicKey,
        })
        .signers([a.user])
        .rpc();
      await expectError(p, "WrongHold");
    });

    it("withdraw with the Breakglass accounts omitted fails", async () => {
      const ix = await withdrawIx(a, 10, nextNonce());
      const drop = new Set(
        [
          pausePda,
          a.limiter,
          eventAuthorityPda,
          breakglass.programId,
          configPda,
        ].map((k) => k.toBase58()),
      );
      ix.keys = ix.keys.filter((k) => !drop.has(k.pubkey.toBase58()));
      const before = await tokenBalance(a.userToken);
      let failed = false;
      try {
        await provider.sendAndConfirm(new Transaction().add(ix), [a.user]);
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);
      expect(await tokenBalance(a.userToken)).to.equal(before);
    });

    it("another protocol's config is rejected by the protected program", async () => {
      // Register a second protocol (the Breakglass program itself stands in).
      await initConfig(breakglass.programId);
      const [otherConfig] = PublicKey.findProgramAddressSync(
        [Buffer.from("config"), breakglass.programId.toBuffer()],
        breakglass.programId,
      );
      const nonce = nextNonce();
      const p = testVault.methods
        .withdraw(new BN(10), nonce)
        .accountsPartial({
          ...withdrawAccounts(a, nonce),
          bgConfig: otherConfig,
        })
        .signers([a.user])
        .rpc();
      await expectError(p, "WrongBreakglassConfig", { framework: true });
    });

    it("check_outflow called directly (not by the protocol's gate PDA) fails with InvalidCaller", async () => {
      const nonce = nextNonce();
      const fakeGate = Keypair.generate();
      const p = breakglass.methods
        .checkOutflow(SCOPE.WITHDRAW, new BN(10), stranger.publicKey, nonce)
        .accountsPartial({
          gateSigner: fakeGate.publicKey,
          payer: stranger.publicKey,
          config: configPda,
          pauseState: pausePda,
          flowLimiter: a.limiter,
          vault: a.vaultToken,
          hold: holdPda(stranger.publicKey, nonce),
        })
        .signers([fakeGate, stranger])
        .rpc();
      await expectError(p, "InvalidCaller");
    });
  });

  describe("init_flow_limiter", () => {
    it("is admin only", async () => {
      const v = await createVault({ limiter: null });
      await expectError(
        initLimiter(guardian, v.mint, v.vaultToken, limiterParams()),
        "Unauthorized",
      );
    });

    it("rejects bad parameters and unpausable scopes", async () => {
      const v = await createVault({ limiter: null });
      const bad = [
        { windowSecs: new BN(11) },
        { capAbsolute: new BN(0) },
        { capBpsOfVault: 10_001 },
        { largeThresholdBps: 10_001 },
        { holdSecs: new BN(0) },
        { autoTripSecs: new BN(0) },
        { screenSecs: new BN(0) },
      ];
      for (const over of bad) {
        await expectError(
          initLimiter(admin, v.mint, v.vaultToken, limiterParams(over)),
          "InvalidLimiterConfig",
        );
      }
      await expectError(
        initLimiter(admin, v.mint, v.vaultToken, {
          ...limiterParams(),
          scope: SCOPE.REPAY,
        }),
        "ScopeUnpausable",
      );
    });

    it("stores defaults and can't be initialized twice", async () => {
      const l = await breakglass.account.flowLimiter.fetch(a.limiter);
      expect(l.vault.toBase58()).to.equal(a.vaultToken.toBase58());
      expect(l.windowSecs.toNumber()).to.equal(3600);
      expect(l.autoTripSecs.toNumber()).to.equal(3600);
      expect(l.instantAllowance.toString()).to.equal("18446744073709551615");
      let failed = false;
      try {
        await initLimiter(admin, a.mint, a.vaultToken, limiterParams());
      } catch {
        failed = true;
      }
      expect(failed).to.equal(true);
    });
  });
});
