// Phase 4 manual check: a loosening change waits out the timelock, an early
// execute is rejected, a guardian veto kills it; tightening applies at once.
//
//   solana-test-validator --reset        # terminal 1
//   anchor deploy                        # terminal 2
//   yarn ts-node scripts/demo-timelock.ts
//
// The wallet is the Breakglass admin; the guardian is a local demo key
// (.anchor/demo-guardian-keypair.json, gitignored).

import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { parseBreakglassError } from "../clients/ts/src/errors";
import { run, setup } from "./demo-common";

const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));
const errName = (e: unknown) => {
  const err = parseBreakglassError(e);
  if (!err) throw e;
  return err.name;
};

run(async () => {
  const {
    bg,
    connection,
    payer,
    guardian,
    guardianRegistered,
    config,
    newVault,
    reopenWithdraw,
  } = await setup();
  if (!(await guardianRegistered())) {
    throw new Error(
      "this validator's config was registered without the demo guardian: restart with " +
        "`solana-test-validator --reset` and `anchor deploy`",
    );
  }
  await connection.confirmTransaction(
    await connection.requestAirdrop(guardian.publicKey, LAMPORTS_PER_SOL),
    "confirmed",
  );
  await reopenWithdraw();
  const v = await newVault(
    { cap: tokens(1000), threshold: tokens(200), holdSecs: null },
    tokens(100),
  );
  const cur = await bg.account.flowLimiter.fetch(v.flowLimiter);
  const params = {
    windowSecs: cur.windowSecs,
    capAbsolute: cur.capAbsolute,
    capBpsOfVault: cur.capBpsOfVault,
    largeThreshold: cur.largeThreshold,
    largeThresholdBps: cur.largeThresholdBps,
    holdSecs: cur.holdSecs,
    autoTripSecs: cur.autoTripSecs,
    instantAllowance: cur.instantAllowance,
    screenSecs: cur.screenSecs,
  };

  // 1. Admin proposes raising the cap 1000 -> 5000 tokens.
  const id = (await bg.account.protocolConfig.fetch(config)).nextChangeId;
  const [pending] = PublicKey.findProgramAddressSync(
    [Buffer.from("cfgchg"), config.toBuffer(), id.toArrayLike(Buffer, "le", 8)],
    bg.programId,
  );
  await bg.methods
    .proposeConfig({
      raiseLimits: {
        mint: v.mint,
        params: { ...params, capAbsolute: tokens(5000) },
      },
    })
    .accountsPartial({
      payer: payer.publicKey,
      admin: payer.publicKey,
      config,
      pending,
    })
    .rpc();
  const p = await bg.account.pendingConfig.fetch(pending);
  const hours = (p.executableAt.toNumber() - p.proposedAt.toNumber()) / 3600;
  console.log(
    `1. proposal QUEUED: raise cap 1000 -> 5000 tokens (change ${pending.toBase58()}), ` +
      `executable at ${new Date(
        p.executableAt.toNumber() * 1000,
      ).toISOString()} (${hours}h)`,
  );

  // 2. Executing early is rejected.
  const execute = () =>
    bg.methods
      .executeConfig()
      .accountsPartial({
        config,
        pending,
        flowLimiter: v.flowLimiter,
        hold: null,
      })
      .rpc();
  try {
    await execute();
    throw new Error("early execute went through");
  } catch (e) {
    console.log(`2. early execute rejected: ${errName(e)}`);
  }

  // 3. The guardian vetoes; it can never execute now.
  await bg.methods
    .vetoConfig()
    .accountsPartial({ guardian: guardian.publicKey, config, pending })
    .signers([guardian])
    .rpc();
  try {
    await execute();
    throw new Error("vetoed change executed");
  } catch (e) {
    console.log(`3. guardian VETOED it; execute now fails with: ${errName(e)}`);
  }

  // 4. Tightening needs no timelock.
  await bg.methods
    .tightenLimits({ ...params, capAbsolute: tokens(800) })
    .accountsPartial({
      admin: payer.publicKey,
      config,
      flowLimiter: v.flowLimiter,
    })
    .rpc();
  const after = await bg.account.flowLimiter.fetch(v.flowLimiter);
  console.log(
    `4. cap LOWERED at once: ${after.capAbsolute
      .div(new BN(1_000_000))
      .toString()} tokens (no timelock for tightening)`,
  );
});
