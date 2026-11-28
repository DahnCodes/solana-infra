/// <reference types="node" />
// Creates every vault the attack suite uses (each with a victim's 10,000-token
// deposit) and writes their mints to the fixtures file, so the shared monitor
// can watch all vault token accounts from the start. Prints the vault token
// accounts, one per line, for run.sh to put in the monitor config.
//
// Needs the planted-bug build of test-vault (some vaults turn invariants off).

import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { setup } from "../demo-common";
import { log, tokens } from "./lib";

const BIG = tokens(1_000_000);
const SCREEN_ALL = new BN(0);

async function main() {
  const ctx = await setup();
  const specs: [string, Parameters<typeof ctx.createVault>[0], boolean][] = [
    // name, limiter, invariantsOff
    ["bypass", { cap: BIG, threshold: BIG, holdSecs: null }, false],
    ["big_drain_guarded", { cap: BIG, threshold: BIG, holdSecs: null }, false],
    [
      "big_drain_screened",
      {
        cap: BIG,
        threshold: BIG,
        holdSecs: null,
        instantAllowance: SCREEN_ALL,
      },
      true,
    ],
    [
      "many_small",
      { cap: tokens(1000), threshold: tokens(400), holdSecs: null },
      true,
    ],
    [
      "many_small_screened",
      {
        cap: BIG,
        threshold: BIG,
        holdSecs: null,
        instantAllowance: SCREEN_ALL,
      },
      true,
    ],
    ["rogue", { cap: tokens(100), threshold: BIG, holdSecs: null }, false],
    [
      "stolen_admin",
      { cap: BIG, threshold: tokens(50), holdSecs: null },
      false,
    ],
    [
      "outage",
      { cap: tokens(1000), threshold: tokens(400), holdSecs: null },
      true,
    ],
  ];
  const vaults: Record<string, string> = {};
  const accounts: string[] = [];
  for (const [name, limiter, invariantsOff] of specs) {
    const v = ctx.vaultFor(await ctx.createVault(limiter, { invariantsOff }));
    await v.addUser(tokens(10_000)); // the victim
    vaults[name] = v.mint.toBase58();
    accounts.push(v.vaultToken.toBase58());
    log(
      `vault ${name}: mint ${v.mint.toBase58()}, token account ${v.vaultToken.toBase58()}`,
    );
  }
  const protocol = process.env.ATTACK_PROTOCOL ?? `attack-suite-${Date.now()}`;
  const file =
    process.env.ATTACK_FIXTURES ??
    path.join(__dirname, "../../.anchor/attack-fixtures.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ protocol, vaults }, null, 2));
  console.log(accounts.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
