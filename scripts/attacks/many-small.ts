/// <reference types="node" />
// Attack: hundreds of sub-threshold withdrawals, from many wallets and with
// several withdrawals per transaction, through the planted bug (each wallet
// deposited 10 tokens and asks for far more).
//   capped:   cap 1,000 tokens            -> the cap trips; the take is <= cap
//   screened: screen-all (zero-loss mode) -> every withdrawal held; the bot freezes them
// Pass: <= cap taken (0 in zero-loss mode), alerts at 50% and 80% of the cap
// and on the trip, and every screened hold frozen before release.

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { setup, WITHDRAW } from "../demo-common";
import {
  attack,
  balance,
  Checks,
  fmt,
  log,
  mint,
  sleep,
  tokens,
  waitIncident,
} from "./lib";

const WALLETS = 10;
const PER_TX = 4;
const CHUNK = tokens(10); // threshold is 400
const CAP = 1000n * 1_000_000n;
const MAX_ATTEMPTS = 240;

attack("many-small", async () => {
  const since = new Date(Date.now() - 2_000);
  const ctx = await setup();
  await ctx.reopenWithdraw();
  const c = new Checks();

  // ---- capped vault -------------------------------------------------------
  const v = ctx.vaultFor(mint("many_small"));
  log(`  creating ${WALLETS} attacker wallets ...`);
  const attackers = [];
  for (let i = 0; i < WALLETS; i++) attackers.push(await v.addUser(tokens(10)));
  const v0 = await balance(ctx.connection, v.vaultToken); // after the attackers' own deposits
  let attempts = 0;
  let batched = 0;
  const failures = new Map<number, number>();
  // Batches of PER_TX withdrawals per transaction; once a batch fails (the cap
  // tripped mid-transaction, so it reverted), fall back to one per transaction.
  // Every wallet keeps trying until MAX_ATTEMPTS: persistence must gain nothing.
  while (attempts < MAX_ATTEMPTS) {
    for (let w = 0; w < WALLETS && attempts < MAX_ATTEMPTS; w++) {
      const a = attackers[w];
      const n = (failures.get(w) ?? 0) === 0 ? PER_TX : 1;
      const ixs = [];
      for (let k = 0; k < n; k++) ixs.push((await a.withdrawIx(CHUNK)).ix);
      attempts += n;
      try {
        await a.send(ixs);
        if (n > 1) batched++;
      } catch {
        failures.set(w, (failures.get(w) ?? 0) + 1);
      }
    }
  }
  let taken = 0n;
  for (const a of attackers)
    taken += await balance(ctx.connection, a.userToken);
  const v1 = await balance(ctx.connection, v.vaultToken);
  log(
    `  ${attempts} withdrawal attempts (${batched} multi-withdraw transactions); taken ${fmt(
      taken,
    )}`,
  );
  c.check(
    taken <= CAP,
    "taken <= one window's cap",
    `${fmt(taken)} of ${fmt(CAP)}`,
  );
  c.check(
    v0 - v1 === taken,
    "vault drop equals what the attackers got",
    fmt(v0 - v1),
  );
  const s = await ctx.bg.account.pauseState.fetch(ctx.pauseState);
  const now = Math.floor(Date.now() / 1000);
  c.check(
    s.active.some(
      (p) =>
        p.scope === WITHDRAW &&
        p.kind.autoTrip !== undefined &&
        p.pausedUntil.toNumber() > now,
    ),
    "the scope auto-tripped",
  );
  for (const [sev, what] of [
    ["warning", "50%"],
    ["high", "80%"],
  ]) {
    const hit = await waitIncident(
      since,
      (i) =>
        i.detector === "window_usage" &&
        (i.severity === sev || (sev === "warning" && i.severity === "high")),
    );
    c.check(!!hit, `alert at ${what} of the cap`, hit?.title?.slice(0, 60));
  }
  const trip = await waitIncident(
    since,
    (i) => i.detector === "pause_trip" && i.severity === "critical",
  );
  c.check(!!trip, "Critical alert on the trip", trip?.title?.slice(0, 60));

  // ---- screened vault (zero-loss mode) --------------------------------------
  await ctx.reopenWithdraw();
  const z = ctx.vaultFor(mint("many_small_screened"));
  const holds: PublicKey[] = [];
  for (let i = 0; i < 5; i++) {
    const a = await z.addUser(tokens(10));
    const ws = [];
    for (let k = 0; k < PER_TX; k++) ws.push(await a.withdrawIx(CHUNK));
    await a.send(ws.map((w) => w.ix));
    holds.push(...ws.map((w) => w.hold));
  }
  const z0 = await balance(ctx.connection, z.vaultToken); // after deposits; holds move nothing
  log(
    `  zero-loss mode: ${holds.length} withdrawals held for screening; waiting for the bot ...`,
  );
  const releaseAt = (
    await ctx.bg.account.pendingWithdrawal.fetch(holds[0])
  ).releaseAt.toNumber();
  const status = async () =>
    Promise.all(
      holds.map(
        async (h) =>
          Object.keys(
            (await ctx.bg.account.pendingWithdrawal.fetch(h)).status,
          )[0],
      ),
    );
  let st = await status();
  while (st.some((x) => x !== "frozen") && Date.now() / 1000 < releaseAt - 5) {
    await sleep(1000);
    st = await status();
  }
  const frozen = st.filter((x) => x === "frozen").length;
  c.check(
    frozen === holds.length,
    "every screened withdrawal frozen before release",
    `${frozen}/${holds.length}`,
  );
  const z1 = await balance(ctx.connection, z.vaultToken);
  c.check(z1 === z0, "zero-loss vault unchanged", fmt(z0 - z1));
  return c.summary(
    `${attempts} withdrawals from ${WALLETS} wallets took ${fmt(
      taken,
    )} (<= ${fmt(
      CAP,
    )} cap) before the trip, with 50%/80%/trip alerts; zero-loss mode: ${frozen}/${
      holds.length
    } frozen, 0 taken`,
  );
});
