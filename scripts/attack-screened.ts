// Phase 6 manual check: a fresh wallet's screened withdrawals get frozen by
// the guardian bot before they release.
//
//   solana-test-validator --reset                          # terminal 1
//   anchor deploy                                          # terminal 2
//   docker compose -f monitor/docker-compose.yml up -d
//   # monitor/.env: GUARDIAN_KEYPAIR_PATH=<repo>/.anchor/demo-guardian-keypair.json
//   # monitor/config.toml: [bot] enabled = true
//   (cd monitor && cargo run -- --config config.toml)      # terminal 3 (start it after this script's first run
//                                                          #  registered the demo guardian, or run demo-timelock once)
//   yarn ts-node scripts/attack-screened.ts
//
// A brand-new wallet deposits into a screen-all vault (instant allowance 0)
// and asks for 3 withdrawals. Each is held for screen_secs (120s). The bot
// sees a wallet first seen moments ago (fresh_address) and freezes all of them.
// Prints `ATTACK FAILED: N/N withdrawals frozen by guardian bot` (exit 0), or
// `ATTACK SUCCEEDED: ...` (exit 1) if any hold is still open at release time.

import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { run, setup } from "./demo-common";

const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

run(async () => {
  const {
    bg,
    connection,
    guardian,
    guardianRegistered,
    newVault,
    reopenWithdraw,
  } = await setup();
  if (!(await guardianRegistered())) {
    throw new Error(
      "the config wasn't registered with the demo guardian: restart with solana-test-validator --reset",
    );
  }
  // The bot pays its own fees.
  if (
    (await connection.getBalance(guardian.publicKey)) <
    LAMPORTS_PER_SOL / 10
  ) {
    await connection.confirmTransaction(
      await connection.requestAirdrop(guardian.publicKey, LAMPORTS_PER_SOL),
      "confirmed",
    );
  }
  await reopenWithdraw();

  const attacker = await newVault(
    {
      cap: tokens(1_000_000),
      threshold: tokens(1_000_000),
      holdSecs: null,
      instantAllowance: new BN(0),
    },
    tokens(1000),
  );
  console.log(
    `attacker wallet ${attacker.user.publicKey.toBase58()} (created just now)`,
  );
  const holds: PublicKey[] = [];
  for (let i = 0; i < 3; i++)
    holds.push((await attacker.withdraw(tokens(100))).hold);
  const releaseAt = (
    await bg.account.pendingWithdrawal.fetch(holds[0])
  ).releaseAt.toNumber();
  console.log(
    `3 withdrawals held for screening until ${new Date(
      releaseAt * 1000,
    ).toISOString()}`,
  );

  const status = async () =>
    Promise.all(
      holds.map(
        async (h) =>
          Object.keys((await bg.account.pendingWithdrawal.fetch(h)).status)[0],
      ),
    );
  let s = await status();
  while (s.some((x) => x !== "frozen") && Date.now() / 1000 < releaseAt) {
    await sleep(1000);
    s = await status();
  }
  const frozen = s.filter((x) => x === "frozen").length;
  if (frozen === holds.length) {
    console.log(
      `ATTACK FAILED: ${frozen}/${holds.length} withdrawals frozen by guardian bot`,
    );
  } else {
    console.log(
      `ATTACK SUCCEEDED: only ${frozen}/${
        holds.length
      } frozen before release (${s.join(
        ", ",
      )}); is the monitor running with [bot] enabled?`,
    );
    process.exit(1);
  }
});
