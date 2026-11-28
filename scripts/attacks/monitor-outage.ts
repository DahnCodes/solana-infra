/// <reference types="node" />
// Attack: blind the monitor, then drain. A dedicated monitor instance watches
// the chain through a TCP proxy; the proxy is killed (every ingestor dead),
// then attackers drain through the planted bug in small chunks.
// Pass: liveness alerts fire, and the on-chain gate alone caps the take at
// one window's cap. Needs a plain-http RPC (localnet, or OUTAGE_RPC/OUTAGE_WS
// as host:port) because the proxy can't forward TLS.

import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { setup } from "../demo-common";
import { attack, balance, Checks, fmt, log, mint, sleep, tokens } from "./lib";

const root = path.join(__dirname, "../..");
const CAP = 1000n * 1_000_000n;

function target(
  env: string | undefined,
  url: string,
  wsPort: boolean,
): [string, number] {
  if (env) {
    const [h, p] = env.split(":");
    return [h, Number(p)];
  }
  const u = new URL(url);
  if (u.protocol !== "http:")
    throw new Error(
      "monitor-outage needs a plain-http RPC: set OUTAGE_RPC and OUTAGE_WS (host:port)",
    );
  const port = Number(u.port || 80);
  return [u.hostname, wsPort ? port + 1 : port];
}

function proxy(listen: number, host: string, port: number) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(port, host);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => s.destroy());
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(listen, "127.0.0.1");
  return () => {
    server.close();
    sockets.forEach((s) => s.destroy());
  };
}

attack("monitor-outage", async () => {
  const ctx = await setup();
  await ctx.reopenWithdraw();
  const c = new Checks();
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const [rh, rp] = target(process.env.OUTAGE_RPC, url, false);
  const [wh, wp] = target(process.env.OUTAGE_WS, url, true);
  const kills = [proxy(48899, rh, rp), proxy(48900, wh, wp)];
  const v = ctx.vaultFor(mint("outage"));
  const tv = JSON.parse(
    fs.readFileSync(path.join(root, "target/idl/test_vault.json"), "utf8"),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-outage-"));
  const cfg = path.join(dir, "config.toml");
  fs.writeFileSync(
    cfg,
    `[network]
rpc_urls = ["http://127.0.0.1:48899"]
ws_urls = ["ws://127.0.0.1:48900"]
[protocol]
name = "outage-${Date.now()}"
breakglass_program = "${ctx.bg.programId.toBase58()}"
protected_program = "${tv.address}"
vault_token_accounts = ["${v.vaultToken.toBase58()}"]
[detectors]
window_warning_pct = 50
window_high_pct = 80
heartbeat_timeout_secs = 10
[alerts]
sinks = ["stdout"]
critical_repage_secs = 120
[api]
bind = "127.0.0.1:18095"
`,
  );
  const out: string[] = [];
  const logs: string[] = [];
  let monitor: ChildProcess | undefined;
  try {
    monitor = spawn(
      path.join(root, "monitor/target/debug/breakglass-monitor"),
      ["--config", cfg],
      {
        cwd: dir,
        env: { ...process.env, RUST_LOG: "info" },
      },
    );
    monitor.stdout!.on("data", (d) =>
      out.push(...d.toString().split("\n").filter(Boolean)),
    );
    monitor.stderr!.on("data", (d) =>
      logs.push(...d.toString().split("\n").filter(Boolean)),
    );
    for (
      let i = 0;
      i < 100 && !logs.some((l) => l.includes("ingestor subscribed"));
      i++
    )
      await sleep(200);
    c.check(
      logs.some((l) => l.includes("ingestor subscribed")),
      "monitor started and subscribed",
    );

    log("  killing the monitor's only RPC ...");
    kills.forEach((k) => k());
    for (let i = 0; i < 60 && !out.some((l) => l.includes("liveness")); i++)
      await sleep(500);
    const live = out.find((l) => l.startsWith("[HIGH] liveness"));
    const blind = out.find((l) => l.startsWith("[CRITICAL] liveness"));
    c.check(!!live, "liveness alert for the dead ingestor", live?.slice(0, 60));
    c.check(!!blind, "Critical: every watcher silent", blind?.slice(0, 60));

    log("  draining while the monitor is blind ...");
    const attackers = [];
    for (let i = 0; i < 5; i++) attackers.push(await v.addUser(tokens(10)));
    const v0 = await balance(ctx.connection, v.vaultToken); // after the attackers' deposits
    let refused = 0;
    for (let round = 0; round < 40 && refused < attackers.length * 2; round++) {
      for (const a of attackers) {
        await a.withdraw(tokens(50)).catch(() => refused++);
      }
    }
    let taken = 0n;
    for (const a of attackers)
      taken += await balance(ctx.connection, a.userToken);
    const v1 = await balance(ctx.connection, v.vaultToken);
    c.check(
      taken <= CAP,
      "the gate capped the take at one window's cap",
      `${fmt(taken)} of ${fmt(CAP)}`,
    );
    c.check(
      v0 - v1 === taken,
      "vault drop equals what the attackers got",
      fmt(v0 - v1),
    );
    return c.summary(
      `monitor blind (liveness + all-silent alerts), and the on-chain gate alone held the drain to ${fmt(
        taken,
      )} (cap ${fmt(CAP)})`,
    );
  } finally {
    monitor?.kill("SIGINT");
    kills.forEach((k) => k());
  }
});
