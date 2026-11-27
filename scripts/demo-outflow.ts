// Phase 2 manual check: Allow / Hold / auto-trip through test-vault.
//
//   solana-test-validator --reset        # terminal 1
//   anchor deploy                        # terminal 2
//   yarn ts-node scripts/demo-outflow.ts
//
// Limiter for a fresh mint: cap 1000 tokens per window, large-withdrawal
// threshold 200 tokens, holds of 60s. The run leaves WITHDRAW auto-tripped
// (for UI work); the next run unpauses it first.

import { BN } from "@coral-xyz/anchor";
import { parseBreakglassError } from "../clients/ts/src/errors";
import { run, setup } from "./demo-common";

const errName = (e: unknown) => {
  const err = parseBreakglassError(e);
  if (!err) throw e;
  return err.name;
};

run(async () => {
  const { bg, connection, pauseState, newVault, reopenWithdraw } =
    await setup();
  await reopenWithdraw();
  const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));
  const v = await newVault(
    { cap: tokens(1000), threshold: tokens(200), holdSecs: new BN(60) },
    tokens(5000),
  );
  const balance = async () =>
    Number(
      (await connection.getTokenAccountBalance(v.userToken)).value.uiAmount,
    );

  // 1. Small withdraw: allowed.
  let before = await balance();
  await v.withdraw(tokens(50));
  console.log(
    `1. small withdraw ALLOWED (+${(await balance()) - before} tokens)`,
  );

  // 2. Large withdraw: held.
  before = await balance();
  const { hold } = await v.withdraw(tokens(300));
  const h = await bg.account.pendingWithdrawal.fetch(hold);
  const until = new Date(h.releaseAt.toNumber() * 1000).toISOString();
  console.log(
    `2. large withdraw HELD until ${until} (+${
      (await balance()) - before
    } tokens, hold ${hold.toBase58()})`,
  );

  // 3. Claim before release_at.
  try {
    await v.claim(hold);
    throw new Error("claim went through before release_at");
  } catch (e) {
    console.log(`3. claim too early: ${errName(e)}`);
  }

  // 4. 20 chunked withdraws of 100 tokens against the 1000-token cap.
  let allowed = 0;
  let held = false;
  let blocked = 0;
  for (let i = 0; i < 20; i++) {
    before = await balance();
    try {
      const { hold: hk } = await v.withdraw(tokens(100));
      if ((await balance()) > before) allowed++;
      else {
        const k = await bg.account.pendingWithdrawal.fetch(hk);
        held = held || k.kind.limit !== undefined;
      }
    } catch (e) {
      if (errName(e) !== "ScopePaused") throw e;
      blocked++;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const tripped = (await bg.account.pauseState.fetch(pauseState)).active.some(
    (p) => p.kind.autoTrip !== undefined && p.pausedUntil.toNumber() > now,
  );
  if (!held || !tripped)
    throw new Error(
      `expected a limit hold and an auto-trip (held=${held}, tripped=${tripped})`,
    );
  console.log(
    `4. 20 chunked withdraws: first ${allowed} allowed, then HELD and LimitTripped; ` +
      `the remaining ${blocked} blocked: ScopePaused`,
  );
});
