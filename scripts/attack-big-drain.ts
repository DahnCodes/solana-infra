// Phase 3 manual check: one huge withdrawal through the planted bug.
//
// A victim deposits 10,000 tokens and an attacker 100. The attacker then asks
// for 9,000 tokens. With the planted bug, test-vault skips the position check;
// the zero-loss invariants revert the transaction (InvariantViolated). In a
// default build the bug isn't there and the vault refuses (InsufficientPosition).
//
//   solana-test-validator --reset                                   # terminal 1
//   anchor build -p test_vault -- --features planted-bug && anchor deploy   # terminal 2
//   yarn ts-node scripts/attack-big-drain.ts
//   anchor build -p test_vault && anchor deploy                    # put the safe build back
//
// Prints `ATTACK FAILED: vault balance unchanged (X tokens)` and exits 0 when
// the drain was stopped; prints `ATTACK SUCCEEDED` and exits 1 otherwise.

import { BN } from "@coral-xyz/anchor";
import { run, setup } from "./demo-common";

const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));

run(async () => {
  const { connection, newVault, reopenWithdraw } = await setup();
  await reopenWithdraw();
  // Generous limiter (cap and threshold above the drain), so only the
  // invariants (or the missing bug) can stop it.
  const victim = await newVault(
    { cap: tokens(1_000_000), threshold: tokens(1_000_000), holdSecs: null },
    tokens(10_000),
  );
  const attacker = await victim.addUser(tokens(100));
  const vaultBalance = async () =>
    Number(
      (await connection.getTokenAccountBalance(victim.vaultToken)).value
        .uiAmount,
    );

  const before = await vaultBalance();
  console.log(
    `vault holds ${before} tokens; attacker's position is 100 tokens`,
  );
  console.log("attacker withdraws 9000 tokens...");
  let reason = "";
  try {
    await attacker.withdraw(tokens(9_000));
  } catch (e: any) {
    const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
    const text = [String(e?.message), ...logs].join("\n");
    reason =
      e?.error?.errorCode?.code ??
      /Error Code: (\w+)/.exec(text)?.[1] ??
      String(e);
    if (/invariant violated: (\w+)/.test(text)) {
      reason += ` (${/invariant violated: (\w+)/.exec(text)![1]})`;
    }
  }
  const after = await vaultBalance();

  if (reason && after === before) {
    console.log(`transaction reverted: ${reason}`);
    console.log(`ATTACK FAILED: vault balance unchanged (${after} tokens)`);
  } else {
    console.log(
      `ATTACK SUCCEEDED: vault went from ${before} to ${after} tokens`,
    );
    process.exit(1);
  }
});
