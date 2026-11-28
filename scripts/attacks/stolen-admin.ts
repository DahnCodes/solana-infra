/// <reference types="node" />
// Attack: the admin key is stolen. The attacker tries to raise limits, add a
// guardian of their own, hand themselves the admin role, release a frozen
// withdrawal, and push a program upgrade.
// Pass: every config change is timelocked (TimelockActive), alerted
// (config_change), and vetoed by the guardian (Vetoed); the frozen funds stay
// frozen; the upgrade raises a Critical alert. Delaying upgrades themselves
// needs the optional upgrade vault (BUILD_PLAN Phase 8): by default the
// spec only alerts on upgrades.

import { execFileSync } from "child_process";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { setup } from "../demo-common";
import {
  attack,
  balance,
  Checks,
  failsWith,
  fmt,
  log,
  mint,
  sleep,
  tokens,
  waitIncident,
} from "./lib";

const root = path.join(__dirname, "../..");

attack("stolen-admin", async () => {
  const since = new Date(Date.now() - 2_000);
  const ctx = await setup();
  await ctx.reopenWithdraw();
  const c = new Checks();
  const v = ctx.vaultFor(mint("stolen_admin"));
  const thief = Keypair.generate().publicKey;

  // A frozen withdrawal to try to release (threshold 50: a 60-token withdrawal is held).
  const user = await v.addUser(tokens(100));
  const v0 = await balance(ctx.connection, v.vaultToken); // after the deposit
  const { hold } = await user.withdraw(tokens(60));
  let status = Object.keys(
    (await ctx.bg.account.pendingWithdrawal.fetch(hold)).status,
  )[0];
  for (let i = 0; i < 20 && status !== "frozen"; i++) {
    await sleep(500); // the bot usually freezes it (fresh wallet)
    status = Object.keys(
      (await ctx.bg.account.pendingWithdrawal.fetch(hold)).status,
    )[0];
  }
  if (status !== "frozen") {
    await ctx.bg.methods
      .freezeHeld()
      .accountsPartial({
        authority: ctx.guardian.publicKey,
        config: ctx.config,
        hold,
      })
      .signers([ctx.guardian])
      .rpc();
  }

  const lim = await ctx.bg.account.flowLimiter.fetch(v.flowLimiter);
  const policy = (await ctx.bg.account.protocolConfig.fetch(ctx.config)).policy;
  const params = {
    windowSecs: lim.windowSecs,
    capAbsolute: new BN("18446744073709551615"),
    capBpsOfVault: 0,
    largeThreshold: new BN("18446744073709551615"),
    largeThresholdBps: 0,
    holdSecs: lim.holdSecs,
    autoTripSecs: lim.autoTripSecs,
    instantAllowance: new BN("18446744073709551615"),
    screenSecs: lim.screenSecs,
  };
  const changes: [string, any, any][] = [
    [
      "raise limits to unlimited",
      { raiseLimits: { mint: v.mint, params } },
      { flowLimiter: v.flowLimiter, hold: null },
    ],
    [
      "add the thief as guardian",
      { addGuardian: { guardian: thief } },
      { flowLimiter: null, hold: null },
    ],
    [
      "make the thief admin",
      { setAdmin: { admin: thief } },
      { flowLimiter: null, hold: null },
    ],
    [
      "release the frozen withdrawal",
      { releaseHeld: { hold } },
      { flowLimiter: null, hold },
    ],
    [
      "shorten the timelock and loosen the policy",
      {
        changePolicy: {
          policy,
          unpausableMask: new BN("18446744073709551615").subn(2),
          timelockSecs: new BN(24 * 3600),
        },
      },
      { flowLimiter: null, hold: null },
    ],
  ];
  for (const [what, action, extra] of changes) {
    const id = (await ctx.bg.account.protocolConfig.fetch(ctx.config))
      .nextChangeId;
    const pending = PublicKey.findProgramAddressSync(
      [
        Buffer.from("cfgchg"),
        ctx.config.toBuffer(),
        id.toArrayLike(Buffer, "le", 8),
      ],
      ctx.bg.programId,
    )[0];
    await ctx.bg.methods
      .proposeConfig(action)
      .accountsPartial({
        payer: ctx.payer.publicKey,
        admin: ctx.payer.publicKey,
        config: ctx.config,
        pending,
      })
      .rpc();
    const exec = () =>
      ctx.bg.methods
        .executeConfig()
        .accountsPartial({ config: ctx.config, pending, ...extra })
        .rpc();
    const early = await failsWith(exec());
    const alert = await waitIncident(
      since,
      (i) =>
        i.detector === "config_change" &&
        i.title.startsWith("ConfigChangeProposed") &&
        i.signatures.length > 0 &&
        i.title.includes(
          Object.keys(action)[0].replace(/^./, (x: string) => x.toUpperCase()),
        ),
    );
    await ctx.bg.methods
      .vetoConfig()
      .accountsPartial({
        guardian: ctx.guardian.publicKey,
        config: ctx.config,
        pending,
      })
      .signers([ctx.guardian])
      .rpc();
    const after = await failsWith(exec());
    c.check(
      early === "TimelockActive" && !!alert && after === "Vetoed",
      `${what}: timelocked, alerted, vetoed`,
      `${early}/${alert ? "alert" : "NO ALERT"}/${after}`,
    );
  }
  const h = await ctx.bg.account.pendingWithdrawal.fetch(hold);
  c.check(
    Object.keys(h.status)[0] === "frozen",
    "the frozen withdrawal is still frozen",
  );
  const v1 = await balance(ctx.connection, v.vaultToken);
  c.check(v1 === v0, "nothing left the vault", fmt(v0 - v1));
  const cfg = await ctx.bg.account.protocolConfig.fetch(ctx.config);
  c.check(
    cfg.admin.equals(ctx.payer.publicKey) &&
      !cfg.guardians.some((g) => g.equals(thief)),
    "admin and guardians unchanged",
  );

  // Upgrade test-vault (same code; ProgramData still changes).
  log("  upgrading test-vault ...");
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  execFileSync(
    "solana",
    [
      "program",
      "deploy",
      "-u",
      url,
      "--program-id",
      path.join(root, "target/deploy/test_vault-keypair.json"),
      path.join(root, "target/deploy/test_vault.so"),
    ],
    { stdio: "ignore" },
  );
  const up = await waitIncident(
    since,
    (i) => i.detector === "program_upgrade" && i.severity === "critical",
    60_000,
  );
  c.check(!!up, "the upgrade raised a Critical alert", up?.title?.slice(0, 60));
  return c.summary(
    "raising limits, adding a guardian, taking admin, releasing frozen funds and loosening policy were all timelocked, alerted and vetoed; 0 taken; the upgrade was alerted Critical (delaying it needs the Phase 8 upgrade vault)",
  );
});
