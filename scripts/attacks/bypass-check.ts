/// <reference types="node" />
// Attack: bypass the gate.
//   1. Withdraw with the Breakglass accounts omitted.
//   2. Withdraw with fake Breakglass accounts: a system account as the
//      PauseState, another Breakglass account as the PauseState, another
//      vault's limiter.
//   3. Use an unprotected instruction (`skim`, planted bug).
// Pass: 1 and 2 fail with nothing taken; 3 raises a Critical balance_delta
// alert and the guardian bot pauses WITHDRAW within 10s of the drain.
// (The skim itself does move funds: an unprotected path stays open until
// paused. That residual is the spec's, "loss until a pause".)

import { Keypair, Transaction } from "@solana/web3.js";
import { setup, WITHDRAW } from "../demo-common";
import {
  attack,
  balance,
  blockTime,
  botActions,
  Checks,
  errName,
  fmt,
  log,
  mint,
  tokens,
  waitIncident,
} from "./lib";

attack("bypass-check", async () => {
  const since = new Date(Date.now() - 2_000);
  const ctx = await setup();
  await ctx.reopenWithdraw();
  const c = new Checks();
  const v = ctx.vaultFor(mint("bypass"));
  const other = ctx.vaultFor(mint("rogue"));
  const attacker = await v.addUser(tokens(100));
  const vaultBefore = await balance(ctx.connection, v.vaultToken);

  // 1. Omit the Breakglass accounts.
  const { ix } = await attacker.withdrawIx(tokens(50));
  const drop = new Set(
    [ctx.config, ctx.pauseState, v.flowLimiter, ctx.bg.programId].map((k) =>
      k.toBase58(),
    ),
  );
  ix.keys = ix.keys.filter((k) => !drop.has(k.pubkey.toBase58()));
  let err = "";
  try {
    await ctx.provider.sendAndConfirm(new Transaction().add(ix), [
      attacker.user,
    ]);
  } catch (e) {
    err = errName(e);
  }
  c.check(
    err !== "",
    "withdraw without the Breakglass accounts fails",
    err.slice(0, 60),
  );

  // 2. Fake accounts.
  const fakes: [string, Record<string, import("@solana/web3.js").PublicKey>][] =
    [
      [
        "a system account as PauseState",
        { bgPauseState: Keypair.generate().publicKey },
      ],
      ["a FlowLimiter as PauseState", { bgPauseState: v.flowLimiter }],
      ["another mint's limiter", { bgFlowLimiter: other.flowLimiter }],
    ];
  for (const [what, overrides] of fakes) {
    const w = await attacker.withdrawIx(tokens(50), overrides);
    const e = await attacker.send([w.ix]).then(() => "", errName);
    c.check(e !== "", `withdraw with ${what} fails`, e);
  }
  const afterGate = await balance(ctx.connection, v.vaultToken);
  c.check(
    afterGate === vaultBefore,
    "nothing left the vault through the gate",
    fmt(vaultBefore - afterGate),
  );

  // 3. The unprotected path.
  log("  skimming 500 tokens through the unprotected instruction ...");
  const skimSig = await attacker.skim(tokens(500));
  const skimAt = await blockTime(ctx.connection, skimSig);
  const alert = await waitIncident(
    since,
    (i) => i.detector === "balance_delta" && i.severity === "critical",
  );
  c.check(!!alert, "Critical balance_delta alert", alert?.title?.slice(0, 80));
  let pause: any;
  for (let i = 0; i < 60 && !pause; i++) {
    pause = (await botActions(since, "pause")).find((a) => a.ok);
    if (!pause) await new Promise((r) => setTimeout(r, 500));
  }
  if (pause) {
    const secs = (await blockTime(ctx.connection, pause.signature)) - skimAt;
    c.check(
      secs <= 10,
      "the guardian bot paused WITHDRAW within 10s",
      `${secs}s, triggered by ${pause.triggered_by.join(",")}`,
    );
    const s = await ctx.bg.account.pauseState.fetch(ctx.pauseState);
    const byBot = s.active.some(
      (p) => p.scope === WITHDRAW && p.pausedBy.equals(ctx.guardian.publicKey),
    );
    c.check(byBot, "WITHDRAW is paused by the guardian on-chain");
  } else {
    c.check(
      false,
      "the guardian bot paused WITHDRAW",
      "no successful pause action",
    );
  }
  return c.summary(
    `gate bypasses all failed (0 taken); the unprotected skim (500 tokens) raised a Critical alert and the bot paused WITHDRAW`,
  );
});
