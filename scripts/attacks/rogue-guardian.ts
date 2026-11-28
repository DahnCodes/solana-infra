/// <reference types="node" />
// Attack: a guardian key turns hostile. It spams pauses, over-renews, tries to
// unpause an auto-trip, change config and move funds. Then the admin removes it.
// Pass: every abuse blocked; its downtime stays within 24h + 2 renewals (72h);
// after removal it can do nothing.

import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { setup, WITHDRAW } from "../demo-common";
import { attack, Checks, failsWith, log, mint, tokens } from "./lib";

const HOUR = 3600;
const SPARE = 10; // a scope test-vault doesn't use: the rogue's pauses don't block other attacks

attack("rogue-guardian", async () => {
  const ctx = await setup();
  await ctx.reopenWithdraw();
  const c = new Checks();
  const rogue = ctx.guardian2;
  const cfg = await ctx.bg.account.protocolConfig.fetch(ctx.config);
  if (!cfg.guardians.some((g) => g.equals(rogue.publicKey))) {
    return {
      ok: false,
      msg: "guardian2 isn't a guardian of this config (removed by an earlier run?): use a fresh config",
    };
  }
  await ctx.fund(rogue.publicKey, LAMPORTS_PER_SOL / 10);
  const bit = (s: number) => new BN(1).shln(s);
  const ledger = PublicKey.findProgramAddressSync(
    [Buffer.from("gledger"), ctx.config.toBuffer(), rogue.publicKey.toBuffer()],
    ctx.bg.programId,
  )[0];
  const pause = (scopes: BN, secs: number) =>
    ctx.bg.methods
      .pause(scopes, new BN(secs), 666)
      .accountsPartial({
        authority: rogue.publicKey,
        config: ctx.config,
        pauseState: ctx.pauseState,
        guardianLedger: ledger,
      })
      .signers([rogue])
      .rpc();
  const renew = (scopes: BN) =>
    ctx.bg.methods
      .renewPause(scopes)
      .accountsPartial({
        authority: rogue.publicKey,
        config: ctx.config,
        pauseState: ctx.pauseState,
        guardianLedger: ledger,
      })
      .signers([rogue])
      .rpc();
  const unpause = (signer: typeof rogue | null, scopes: BN) =>
    ctx.bg.methods
      .unpause(scopes)
      .accountsPartial({
        authority: (signer ?? ctx.payer).publicKey,
        config: ctx.config,
        pauseState: ctx.pauseState,
      })
      .signers(signer ? [signer] : [])
      .rpc();

  // Spam pauses.
  c.check(
    (await failsWith(pause(bit(SPARE), 25 * HOUR))) === "PauseTooLong",
    "a 25h pause is refused (PauseTooLong)",
  );
  await pause(bit(SPARE), 24 * HOUR);
  c.check(
    (await failsWith(pause(bit(SPARE + 1), 60))) === "GuardianCooldown",
    "a second pause is refused (GuardianCooldown)",
  );
  // Over-renew.
  await renew(bit(SPARE));
  await renew(bit(SPARE));
  c.check(
    (await failsWith(renew(bit(SPARE)))) === "RenewCapReached",
    "a third renewal is refused (RenewCapReached)",
  );
  const s = await ctx.bg.account.pauseState.fetch(ctx.pauseState);
  const mine = s.active.find(
    (p) => p.scope === SPARE && p.pausedBy.equals(rogue.publicKey),
  )!;
  const l = await ctx.bg.account.guardianLedger.fetch(ledger);
  const left = mine.pausedUntil.toNumber() - Math.floor(Date.now() / 1000);
  c.check(
    left <= 72 * HOUR,
    "its pause ends within 72h",
    `${(left / HOUR).toFixed(1)}h left`,
  );
  c.check(
    l.pauseSecsUsed.toNumber() <= cfg.policy.budgetSecsPerPeriod.toNumber(),
    "within the 96h budget",
    `${l.pauseSecsUsed.toNumber() / HOUR}h used`,
  );

  // Unpause an auto-trip.
  const v = ctx.vaultFor(mint("rogue"));
  log("  (tripping the rogue vault's 100-token cap)");
  const victim = await v.addUser(tokens(200));
  await victim.withdraw(tokens(90)); // allowed: 90 of 100
  const { hold } = await victim.withdraw(tokens(90)); // crosses the cap: held + auto-trip
  const tripped = (
    await ctx.bg.account.pauseState.fetch(ctx.pauseState)
  ).active.some((p) => p.scope === WITHDRAW && p.kind.autoTrip !== undefined);
  c.check(tripped, "WITHDRAW auto-tripped (setup)");
  c.check(
    (await failsWith(unpause(rogue, bit(WITHDRAW)))) === "Unauthorized",
    "unpausing the auto-trip is refused (Unauthorized)",
  );

  // Change config / move funds.
  const action = { addGuardian: { guardian: rogue.publicKey } };
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
  const propose = ctx.bg.methods
    .proposeConfig(action)
    .accountsPartial({
      payer: rogue.publicKey,
      admin: rogue.publicKey,
      config: ctx.config,
      pending,
    })
    .signers([rogue])
    .rpc();
  c.check(
    (await failsWith(propose)) === "Unauthorized",
    "proposing a config change is refused",
  );
  const lim = await ctx.bg.account.flowLimiter.fetch(v.flowLimiter);
  const tighten = ctx.bg.methods
    .tightenLimits({ ...lim, capAbsolute: new BN(1) } as any)
    .accountsPartial({
      admin: rogue.publicKey,
      config: ctx.config,
      flowLimiter: v.flowLimiter,
    })
    .signers([rogue])
    .rpc();
  c.check(
    (await failsWith(tighten)) === "Unauthorized",
    "changing limits is refused",
  );
  const remove = ctx.bg.methods
    .removeGuardian(ctx.guardian.publicKey)
    .accountsPartial({ admin: rogue.publicKey, config: ctx.config })
    .signers([rogue])
    .rpc();
  c.check(
    (await failsWith(remove)) === "Unauthorized",
    "removing the other guardian is refused",
  );
  // Move funds: no Breakglass instruction moves funds. The closest power is
  // resolving a held withdrawal, which needs the admin (reject) or the owner (claim).
  const vaultPda = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), v.mint.toBuffer()],
    ctx.vaultProgram.programId,
  )[0];
  const position = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      vaultPda.toBuffer(),
      victim.user.publicKey.toBuffer(),
    ],
    ctx.vaultProgram.programId,
  )[0];
  const reject = ctx.vaultProgram.methods
    .rejectHeld()
    .accountsPartial({
      admin: rogue.publicKey,
      vault: vaultPda,
      position,
      bgConfig: ctx.config,
      bgHold: hold,
      bgEventAuthority: PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")],
        ctx.bg.programId,
      )[0],
      gateSigner: PublicKey.findProgramAddressSync(
        [Buffer.from("breakglass-gate")],
        ctx.vaultProgram.programId,
      )[0],
    })
    .signers([rogue])
    .rpc();
  c.check(
    (await failsWith(reject)) === "Unauthorized",
    "resolving someone's held withdrawal is refused",
  );

  // The admin removes the rogue guardian.
  await ctx.bg.methods
    .removeGuardian(rogue.publicKey)
    .accountsPartial({ admin: ctx.payer.publicKey, config: ctx.config })
    .rpc();
  c.check(
    (await failsWith(pause(bit(SPARE + 2), 60))) === "Unauthorized",
    "after removal its pause is refused (Unauthorized)",
  );
  await unpause(null, bit(SPARE));
  await ctx.reopenWithdraw();
  return c.summary(
    "pause spam, over-renewal, unpausing a trip, config changes and touching held funds all refused; downtime capped at 72h; the admin removed the guardian",
  );
});
