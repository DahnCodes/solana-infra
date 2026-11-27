/// <reference types="node" />
// Phase 5 acceptance: the monitor end to end on localnet.
//
//   solana-test-validator --reset                          # terminal 1
//   anchor deploy                                          # terminal 2
//   docker compose -f monitor/docker-compose.yml up -d     # Postgres
//   (cd monitor && cargo build)
//   yarn ts-node scripts/monitor-e2e.ts
//
// 1. Two TCP proxies in front of the validator act as two independent RPC
//    providers (rpc0, rpc1). The monitor watches both, with the stdout sink,
//    under a fresh protocol name (so earlier runs' incidents don't interfere).
// 2. scripts/demo-outflow.ts runs. The monitor must print LargeWithdrawalQueued
//    (HIGH) and LimitTripped (CRITICAL) within 5s of each transaction's block time.
// 3. rpc1's proxy is killed. A liveness alert must fire for rpc1, /health must
//    say degraded, and a new held withdrawal must still be alerted (via rpc0).
// Prints PASS/FAIL lines and exits non-zero on any failure.

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { Connection } from "@solana/web3.js";

const root = path.join(__dirname, "..");
const VALIDATOR_RPC = 8899;
const VALIDATOR_WS = 8900;
const LATENCY_MS = 5_000;
const HEARTBEAT_TIMEOUT = 10; // seconds; the default is 30, shortened so the run is quick
const API = "127.0.0.1:18080";
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://breakglass:breakglass@localhost:5432/breakglass";

let failures = 0;
const pass = (m: string) => console.log(`PASS: ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`FAIL: ${m}`);
};

/** A TCP proxy; `kill()` closes it and every open connection. */
function proxy(listen: number, target: number) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target, "127.0.0.1");
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => s.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(listen, "127.0.0.1");
  return {
    kill: () => {
      server.close();
      for (const s of sockets) s.destroy();
    },
  };
}

interface Line {
  at: number;
  text: string;
}

function waitFor(
  lines: Line[],
  pred: (l: Line) => boolean,
  ms: number,
): Promise<Line | undefined> {
  return new Promise((resolve) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const hit = lines.find(pred);
      if (hit || Date.now() - start > ms) {
        clearInterval(iv);
        resolve(hit);
      }
    }, 100);
  });
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: root, env: process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}:\n${out}`)),
    );
  });
}

async function latency(
  connection: Connection,
  line: Line,
): Promise<number | undefined> {
  const sig = / \| tx (\w+)/.exec(line.text)?.[1];
  if (!sig) return undefined;
  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.blockTime) return undefined;
  // blockTime has 1s resolution: count from the end of that second.
  return line.at - (tx.blockTime + 1) * 1000;
}

async function main() {
  const connection = new Connection(
    `http://127.0.0.1:${VALIDATOR_RPC}`,
    "confirmed",
  );
  await connection.getSlot().catch(() => {
    throw new Error(
      "no validator on 127.0.0.1:8899: start solana-test-validator and anchor deploy first",
    );
  });
  const bin = path.join(root, "monitor/target/debug/breakglass-monitor");
  if (!fs.existsSync(bin))
    throw new Error("build the monitor first: (cd monitor && cargo build)");

  // A fresh protocol name, so incidents from earlier runs (scoped per protocol)
  // can't absorb this run's alerts.
  const protocol = `test-vault-e2e-${Date.now()}`;

  const idl = (n: string) =>
    JSON.parse(
      fs.readFileSync(path.join(root, `target/idl/${n}.json`), "utf8"),
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-e2e-"));
  const cfg = path.join(dir, "config.toml");
  fs.writeFileSync(
    cfg,
    `[network]
rpc_urls = ["http://127.0.0.1:18899", "http://127.0.0.1:28899"]
ws_urls = ["ws://127.0.0.1:18900", "ws://127.0.0.1:28900"]
[protocol]
name = "${protocol}"
breakglass_program = "${idl("breakglass").address}"
protected_program = "${idl("test_vault").address}"
vault_token_accounts = []
[detectors]
window_warning_pct = 50
window_high_pct = 80
heartbeat_timeout_secs = ${HEARTBEAT_TIMEOUT}
[alerts]
sinks = ["stdout"]
critical_repage_secs = 120
[api]
bind = "${API}"
`,
  );

  const proxies = [proxy(18899, VALIDATOR_RPC), proxy(18900, VALIDATOR_WS)];
  const rpc1 = [proxy(28899, VALIDATOR_RPC), proxy(28900, VALIDATOR_WS)];
  const lines: Line[] = [];
  const logs: string[] = [];
  let monitor: ChildProcess | undefined;
  try {
    monitor = spawn(bin, ["--config", cfg], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL, RUST_LOG: "info" },
    });
    const split = (buf: Buffer, sink: (s: string) => void) =>
      buf.toString().split("\n").filter(Boolean).forEach(sink);
    monitor.stdout!.on("data", (d) =>
      split(d, (t) => lines.push({ at: Date.now(), text: t })),
    );
    monitor.stderr!.on("data", (d) => split(d, (t) => logs.push(t)));
    for (
      let i = 0;
      i < 100 && !logs.some((l) => l.includes("monitor ready"));
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!logs.some((l) => l.includes("monitor ready")))
      throw new Error(`monitor didn't start:\n${logs.join("\n")}`);
    // Let both ingestors subscribe.
    for (
      let i = 0;
      i < 100 &&
      logs.filter((l) => l.includes("ingestor subscribed")).length < 2;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    pass("monitor started with 2 ingestors (rpc0, rpc1)");

    // 2. Alerts within 5s.
    console.log("running scripts/demo-outflow.ts ...");
    await run("yarn", ["-s", "ts-node", "scripts/demo-outflow.ts"]);
    const checks: [string, (t: string) => boolean][] = [
      [
        "LargeWithdrawalQueued (HIGH)",
        (t) =>
          t.startsWith("[HIGH] large_withdrawal") &&
          t.includes("LargeWithdrawalQueued"),
      ],
      [
        "LimitTripped (CRITICAL)",
        (t) =>
          t.startsWith("[CRITICAL] pause_trip") && t.includes("LimitTripped"),
      ],
    ];
    for (const [name, pred] of checks) {
      const hit = await waitFor(lines, (l) => pred(l.text), 10_000);
      if (!hit) {
        fail(`${name} never printed`);
        continue;
      }
      const ms = await latency(connection, hit);
      if (ms === undefined)
        fail(`${name}: no transaction signature in "${hit.text}"`);
      else if (ms > LATENCY_MS)
        fail(`${name} took ${ms}ms after its block (limit ${LATENCY_MS}ms)`);
      else pass(`${name} alerted ${Math.max(ms, 0)}ms after its block`);
    }

    // 3. Kill rpc1.
    rpc1.forEach((p) => p.kill());
    const killedAt = Date.now();
    const live = await waitFor(
      lines,
      (l) =>
        l.at > killedAt &&
        l.text.startsWith("[HIGH] liveness") &&
        l.text.includes("rpc1"),
      (HEARTBEAT_TIMEOUT + 10) * 1000,
    );
    if (live)
      pass(
        `liveness alert for rpc1 after ${((live.at - killedAt) / 1000).toFixed(
          1,
        )}s`,
      );
    else fail("no liveness alert for rpc1");
    const health: any = await (await fetch(`http://${API}/health`)).json();
    if (
      health.status === "degraded" &&
      health.rpc[0].alive &&
      !health.rpc[1].alive
    )
      pass("/health: degraded, rpc0 alive, rpc1 dead");
    else fail(`/health unexpected: ${JSON.stringify(health)}`);

    const before = Date.now();
    await run("yarn", ["-s", "ts-node", "scripts/demo-outflow.ts"]);
    const again = await waitFor(
      lines,
      (l) =>
        l.at > before &&
        l.text.startsWith("[HIGH] large_withdrawal") &&
        l.text.includes("LargeWithdrawalQueued"),
      10_000,
    );
    if (!again) fail("no alert after rpc1 died");
    else {
      const ms = await latency(connection, again);
      if (ms !== undefined && ms <= LATENCY_MS)
        pass(`alerts still arrive with rpc1 dead (${Math.max(ms, 0)}ms)`);
      else fail(`alert after rpc1 died was late or unsigned: ${again.text}`);
    }
    const incidents: any = await (
      await fetch(`http://${API}/incidents?limit=500`)
    ).json();
    const ours = incidents.items.filter((i: any) => i.protocol === protocol);
    if (ours.length >= 4) pass(`${ours.length} incidents recorded in Postgres`);
    else fail(`only ${ours.length} incidents recorded for ${protocol}`);
  } finally {
    monitor?.kill("SIGINT");
    proxies.forEach((p) => p.kill());
    rpc1.forEach((p) => p.kill());
    await new Promise((r) => setTimeout(r, 500));
    if (failures) {
      console.log(
        "--- monitor stdout ---\n" + lines.map((l) => l.text).join("\n"),
      );
      console.log(
        "--- monitor log (last 40) ---\n" + logs.slice(-40).join("\n"),
      );
    }
  }
  console.log(
    failures ? `${failures} check(s) FAILED` : "monitor e2e: all checks passed",
  );
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
