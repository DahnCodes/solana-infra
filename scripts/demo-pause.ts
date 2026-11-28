// Phase 1 manual check: pause WITHDRAW, watch a withdraw fail, unpause, withdraw again.
//
//   solana-test-validator --reset        # terminal 1
//   anchor deploy                        # terminal 2
//   yarn ts-node scripts/demo-pause.ts
//
// The wallet is the Breakglass admin. It pauses as the admin so the script can
// be re-run (a guardian would hit its 6h cooldown on the second run).

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { parseBreakglassError } from "../clients/ts/src/errors";
import { run, setup, WITHDRAW } from "./demo-common";

run(async () => {
  const { bg, payer, config, pauseState, newVault, reopenWithdraw } =
    await setup();
  await reopenWithdraw();
  const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));
  const v = await newVault(
    { cap: tokens(1_000_000), threshold: tokens(1_000_000), holdSecs: null },
    tokens(1000),
  );
  console.log("deposited 1000 tokens");

  const withdrawMask = new BN(1).shln(WITHDRAW);
  const [ledger] = PublicKey.findProgramAddressSync(
    [Buffer.from("gledger"), config.toBuffer(), payer.publicKey.toBuffer()],
    bg.programId,
  );
  await bg.methods
    .pause(withdrawMask, new BN(600), 1)
    .accountsPartial({
      authority: payer.publicKey,
      config,
      pauseState,
      guardianLedger: ledger,
    })
    .rpc();
  console.log("paused WITHDRAW for 600s");

  try {
    await v.withdraw(tokens(100));
    throw new Error("withdraw went through while paused");
  } catch (e) {
    const err = parseBreakglassError(e);
    if (!err) throw e;
    console.log(`withdraw blocked: ${err.name}`);
  }

  await bg.methods
    .unpause(withdrawMask)
    .accountsPartial({ authority: payer.publicKey, config, pauseState })
    .rpc();
  console.log("unpaused WITHDRAW");
  await v.withdraw(tokens(100));
  console.log("withdraw ok");
});
