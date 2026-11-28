/// <reference types="node" />
// Phase 6 acceptance: the guardian bot end to end on localnet.
//
//   solana-test-validator --reset                                         # terminal 1
//   anchor build -p test_vault -- --features planted-bug && anchor deploy # terminal 2 (needs skim)
//   docker compose -f monitor/docker-compose.yml up -d                    # Postgres
//   (cd monitor && cargo build)
//   yarn bot:e2e
//   anchor build -p test_vault && anchor deploy                           # put the safe build back
//
// 1. Screen-all vault (instant allowance 0, screen_secs 120). A normal user
//    (older than the fresh-wallet threshold) and a brand-new attacker both
//    withdraw. The bot must freeze all 3 attacker withdrawals before release;
//    the normal user's must stay queued and be claimable after 120s.
// 2. An unprotected `skim` drains the vault: the bot must pause WITHDRAW within
//    10s of the skim's block (balance_delta).
// 3. After that short pause ends, a second skim makes the bot pause again; the
//    chain refuses (GuardianCooldown). The bot logs it once and keeps running.
//
// The e2e uses a 60s fresh-wallet threshold (default 24h, unit-tested) and a
// 5s bot pause (so step 3 doesn't wait an hour).

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { setup, WITHDRAW } from "./demo-common";

const root = path.join(__dirname, "..");
const API = "127.0.0.1:18081";
const FRESH_SECS = 60;
const BOT_PAUSE_SECS = 5;
const PAUSE_WITHIN_MS = 10_000;
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://breakglass:breakglass@localhost:5432/breakglass";
const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const pass = (m: string) => console.log(`PASS: ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`FAIL: ${m}`);
};

async function until<T>(
  f: () => Promise<T | undefined>,
  ms: number,
  every = 500,
): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
    await sleep(every);
  }
  return undefined;
}

/** A transaction's block time, retrying until the RPC has indexed it. */
async function blockTime(connection: Connection, sig: string): Promise<number> {
  const t = await until(async () => {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return tx?.blockTime ?? undefined;
  }, 30_000);
  if (t === undefined) throw new Error(`transaction ${sig} not found`);
  return t;
}

async function get(p: string): Promise<any> {
  return (await fetch(`http://${API}${p}`)).json();
}

async function main() {
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
  const tv = JSON.parse(
    fs.readFileSync(path.join(root, "target/idl/test_vault.json"), "utf8"),
  );
  await connection.confirmTransaction(
    await connection.requestAirdrop(guardian.publicKey, 2 * LAMPORTS_PER_SOL),
    "confirmed",
  );
  await reopenWithdraw();

  // Screen-all vault, invariants off (planted-bug build) so the attacker can over-withdraw.
  const normal = await newVault(
    {
      cap: tokens(1_000_000),
      threshold: tokens(1_000_000),
      holdSecs: null,
      instantAllowance: new BN(0),
    },
    tokens(1000),
    { invariantsOff: true },
  );
  const normalBornAt = Date.now();
  console.log(
    `vault ${normal.vaultToken.toBase58()}; normal user ${normal.user.publicKey.toBase58()}`,
  );

  // Monitor + bot.
  const protocol = `test-vault-bot-e2e-${Date.now()}`;
  /** This run's bot actions (the store may hold other protocols' too). */
  const ours = async (kind: string): Promise<any[]> =>
    (await get(`/actions?kind=${kind}`)).items.filter(
      (x: any) => x.protocol === protocol,
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-bot-e2e-"));
  const cfg = path.join(dir, "config.toml");
  fs.writeFileSync(
    cfg,
    `[network]
rpc_urls = ["http://127.0.0.1:8899"]
ws_urls = ["ws://127.0.0.1:8900"]
[protocol]
name = "${protocol}"
breakglass_program = "${bg.programId.toBase58()}"
protected_program = "${tv.address}"
vault_token_accounts = ["${normal.vaultToken.toBase58()}"]
[detectors]
window_warning_pct = 50
window_high_pct = 80
heartbeat_timeout_secs = 30
fresh_address_max_age_secs = ${FRESH_SECS}
[alerts]
sinks = ["stdout"]
critical_repage_secs = 120
[api]
bind = "${API}"
[bot]
enabled = true
pause_scopes = [${WITHDRAW}]
pause_secs = ${BOT_PAUSE_SECS}
`,
  );
  const logs: string[] = [];
  const out: string[] = [];
  let monitor: ChildProcess | undefined;
  try {
    monitor = spawn(
      path.join(root, "monitor/target/debug/breakglass-monitor"),
      ["--config", cfg],
      {
        cwd: dir,
        env: {
          ...process.env,
          DATABASE_URL,
          GUARDIAN_KEYPAIR_PATH: path.join(
            root,
            ".anchor/demo-guardian-keypair.json",
          ),
          RUST_LOG: "info",
        },
      },
    );
    monitor.stdout!.on("data", (d) =>
      out.push(...d.toString().split("\n").filter(Boolean)),
    );
    monitor.stderr!.on("data", (d) =>
      logs.push(...d.toString().split("\n").filter(Boolean)),
    );
    const up = await until(
      async () =>
        logs.some((l) => l.includes("ingestor subscribed")) ? true : undefined,
      20_000,
      200,
    );
    if (!up || !logs.some((l) => l.includes("guardian bot running")))
      throw new Error(`monitor/bot didn't start:\n${logs.join("\n")}`);
    pass(
      `monitor and guardian bot running (guardian ${guardian.publicKey.toBase58()})`,
    );

    // ---- 1. screening ------------------------------------------------------
    const wait = normalBornAt + (FRESH_SECS + 3) * 1000 - Date.now();
    if (wait > 0) {
      console.log(
        `waiting ${Math.ceil(
          wait / 1000,
        )}s so the normal user is older than ${FRESH_SECS}s ...`,
      );
      await sleep(wait);
    }
    const attacker = await normal.addUser(tokens(100));
    console.log(
      `attacker ${attacker.user.publicKey.toBase58()} (created just now, deposited 100)`,
    );
    const attackHolds: PublicKey[] = [];
    for (let i = 0; i < 3; i++)
      attackHolds.push((await attacker.withdraw(tokens(3000))).hold);
    const normalHold = (await normal.withdraw(tokens(100))).hold;
    const holdStatus = async (h: PublicKey) =>
      Object.keys((await bg.account.pendingWithdrawal.fetch(h)).status)[0];

    const frozen = await until(async () => {
      const s = await Promise.all(attackHolds.map(holdStatus));
      return s.every((x) => x === "frozen") ? s : undefined;
    }, 60_000);
    const releaseAt = (
      await bg.account.pendingWithdrawal.fetch(attackHolds[0])
    ).releaseAt.toNumber();
    if (frozen && Date.now() / 1000 < releaseAt)
      pass(
        `3/3 attacker withdrawals frozen before release (${Math.round(
          releaseAt - Date.now() / 1000,
        )}s to spare)`,
      );
    else
      fail(
        `attacker holds not all frozen before release: ${(
          await Promise.all(attackHolds.map(holdStatus))
        ).join(", ")}`,
      );
    const actions = { items: await ours("freeze") };
    const triggers = new Set(actions.items.flatMap((a: any) => a.triggered_by));
    console.log(`  freeze triggered by: ${[...triggers].join(", ")}`);

    if ((await holdStatus(normalHold)) === "queued")
      pass("normal user's withdrawal left queued (clean)");
    else fail(`normal user's hold is ${await holdStatus(normalHold)}`);
    const nRelease = (
      await bg.account.pendingWithdrawal.fetch(normalHold)
    ).releaseAt.toNumber();
    console.log(
      `waiting ${Math.max(
        0,
        Math.ceil(nRelease - Date.now() / 1000),
      )}s for the 120s screening window ...`,
    );
    await sleep(Math.max(0, nRelease * 1000 - Date.now()) + 2_000);
    const before = (await connection.getTokenAccountBalance(normal.userToken))
      .value.amount;
    await normal.claim(normalHold);
    const after = (await connection.getTokenAccountBalance(normal.userToken))
      .value.amount;
    if (BigInt(after) - BigInt(before) === BigInt(tokens(100).toString()))
      pass("normal user claimed after 120s");
    else fail(`normal claim moved ${BigInt(after) - BigInt(before)}`);
    let claimErr = "";
    try {
      await attacker.claim(attackHolds[0]);
    } catch (e: any) {
      claimErr = String(e?.error?.errorCode?.code ?? e);
    }
    if (claimErr.includes("HoldFrozen"))
      pass("attacker's claim refused: HoldFrozen");
    else fail(`attacker's claim: ${claimErr || "succeeded"}`);

    // ---- 2. balance delta -> pause ---------------------------------------
    const skimSig = await attacker.skim(tokens(500));
    const skimTime = await blockTime(connection, skimSig);
    const pause = await until(async () => {
      const a = { items: await ours("pause") };
      return a.items.find((x: any) => x.ok) ?? undefined;
    }, 30_000);
    if (!pause) fail("bot never paused after the skim");
    else {
      const ms =
        ((await blockTime(connection, pause.signature)) - skimTime) * 1000;
      if (ms <= PAUSE_WITHIN_MS)
        pass(
          `bot paused WITHDRAW ${
            ms / 1000
          }s after the skim (triggered by ${pause.triggered_by.join(", ")})`,
        );
      else
        fail(
          `bot paused ${ms / 1000}s after the skim (limit ${
            PAUSE_WITHIN_MS / 1000
          }s)`,
        );
    }

    // ---- 3. cooldown: on-chain error, logged once, no crash-loop ----------
    console.log(
      "waiting 65s for the bot's pause to end and its retry backoff ...",
    );
    await sleep(65_000);
    await attacker.skim(tokens(100));
    const refused = await until(async () => {
      const a = { items: await ours("pause") };
      return (
        a.items.find(
          (x: any) => !x.ok && String(x.error).includes("GuardianCooldown"),
        ) ?? undefined
      );
    }, 30_000);
    if (refused)
      pass(`bot hit the cooldown on-chain and logged it: ${refused.error}`);
    else fail("no GuardianCooldown action logged");
    await sleep(10_000);
    const pauses = (await ours("pause")).length;
    const health = await get("/health");
    if (monitor.exitCode === null && health.status === "ok" && pauses === 2)
      pass("bot kept running, no retry loop (2 pause attempts total)");
    else
      fail(
        `after the cooldown error: alive=${monitor.exitCode === null}, health=${
          health.status
        }, pause attempts=${pauses}`,
      );
  } finally {
    monitor?.kill("SIGINT");
    await sleep(500);
    if (failures) {
      console.log("--- monitor stdout ---\n" + out.join("\n"));
      console.log(
        "--- monitor log (last 40) ---\n" + logs.slice(-40).join("\n"),
      );
    }
  }
  console.log(
    failures ? `${failures} check(s) FAILED` : "bot e2e: all checks passed",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
