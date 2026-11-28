/// <reference types="node" />
// Attack: one huge withdrawal through the planted bug (withdraw skips the
// position check). Two vaults:
//   guarded:  invariants on                -> reverted (InvariantViolated)
//   screened: invariants off, screen-all   -> held, then frozen by the bot
// Pass: zero loss in both, a Critical alert for the blocked attempt, and the
// screened hold frozen before it releases.

import { Transaction } from "@solana/web3.js";
import { setup } from "../demo-common";
import {
  attack,
  balance,
  Checks,
  errName,
  fmt,
  log,
  mint,
  sleep,
  tokens,
  waitIncident,
} from "./lib";

attack("big-drain", async () => {
  const since = new Date(Date.now() - 2_000);
  const ctx = await setup();
  await ctx.reopenWithdraw();
  const c = new Checks();

  // Guarded vault: invariants revert it.
  const g = ctx.vaultFor(mint("big_drain_guarded"));
  const a1 = await g.addUser(tokens(100));
  const g0 = await balance(ctx.connection, g.vaultToken);
  log(
    "  guarded vault: withdrawing 9,000 tokens against a 100-token position ...",
  );
  // Exploit scripts usually skip simulation, so the failing transaction lands
  // on-chain (paying fees) and the monitor can see it. A drain that's only
  // simulated never lands: invisible, but it takes nothing either.
  const { ix } = await a1.withdrawIx(tokens(9_000));
  const tx = new Transaction().add(ix);
  tx.feePayer = a1.user.publicKey;
  tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
  tx.sign(a1.user);
  const sig = await ctx.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await ctx.connection.confirmTransaction(sig, "confirmed");
  let logs: string[] = [];
  for (let i = 0; i < 30 && logs.length === 0; i++) {
    const t = await ctx.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    logs = t?.meta?.logMessages ?? [];
    if (logs.length === 0) await sleep(500);
  }
  const err = /Error Code: (\w+)/.exec(logs.join("\n"))?.[1] ?? "";
  c.check(
    err === "InvariantViolated",
    "the drain reverted with InvariantViolated",
    err || "it went through",
  );
  const g1 = await balance(ctx.connection, g.vaultToken);
  c.check(g1 === g0, "guarded vault unchanged", fmt(g0 - g1));
  const crit = await waitIncident(
    since,
    (i) => i.detector === "blocked_exploit" && i.severity === "critical",
  );
  c.check(
    !!crit,
    "Critical alert for the blocked attempt",
    crit?.title?.slice(0, 70),
  );

  // Screened vault (invariants off): held, frozen by the bot.
  const s = ctx.vaultFor(mint("big_drain_screened"));
  const a2 = await s.addUser(tokens(100));
  const s0 = await balance(ctx.connection, s.vaultToken);
  log("  screened vault (invariants off): withdrawing 9,000 tokens ...");
  const { hold } = await a2.withdraw(tokens(9_000));
  const h = await ctx.bg.account.pendingWithdrawal.fetch(hold);
  let status = Object.keys(h.status)[0];
  for (let i = 0; i < 60 && status !== "frozen"; i++) {
    await sleep(1000);
    status = Object.keys(
      (await ctx.bg.account.pendingWithdrawal.fetch(hold)).status,
    )[0];
  }
  c.check(
    status === "frozen" && Date.now() / 1000 < h.releaseAt.toNumber(),
    "the held drain was frozen before release",
    status,
  );
  const s1 = await balance(ctx.connection, s.vaultToken);
  c.check(s1 === s0, "screened vault unchanged", fmt(s0 - s1));
  const flag = await waitIncident(
    since,
    (i) => ["fresh_address", "deposit_history"].includes(i.detector),
    10_000,
  );
  c.check(!!flag, "the held drain was flagged", flag?.detector);
  return c.summary(
    "0 taken: reverted by the invariants (Critical alert), and held + frozen in screen-all mode",
  );
});
