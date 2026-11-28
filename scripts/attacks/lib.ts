/// <reference types="node" />
// Shared helpers for the attack suite (scripts/attacks/*.ts).
//
// Every attack prints exactly one line on stdout, `PASS: <reason>` or
// `FAIL: <what was stolen / what went wrong>`, and exits non-zero on FAIL.
// Progress goes to stderr.
//
// Environment (set by scripts/attacks/run.sh):
//   ATTACK_FIXTURES  JSON written by setup.ts: monitor protocol name + vault mints
//   MONITOR_API      the running monitor's API, e.g. http://127.0.0.1:18090
//   ANCHOR_PROVIDER_URL / ANCHOR_WALLET  cluster and admin wallet (demo-common)

import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";

export const tokens = (n: number) => new BN(n).mul(new BN(1_000_000));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (...a: unknown[]) => console.error(...a);

export interface Fixtures {
  /** Protocol name the shared monitor uses (incidents and actions are filtered by it). */
  protocol: string;
  /** Vault name -> mint. */
  vaults: Record<string, string>;
}

export function fixtures(): Fixtures {
  const file =
    process.env.ATTACK_FIXTURES ??
    path.join(__dirname, "../../.anchor/attack-fixtures.json");
  if (!fs.existsSync(file))
    throw new Error(
      `no fixtures at ${file}: run scripts/attacks/setup.ts (run.sh does)`,
    );
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function mint(name: string): PublicKey {
  const m = fixtures().vaults[name];
  if (!m) throw new Error(`fixture vault ${name} missing: re-run setup.ts`);
  return new PublicKey(m);
}

function api(): string {
  const a = process.env.MONITOR_API;
  if (!a)
    throw new Error(
      "MONITOR_API is not set: the suite checks alerts through the running monitor",
    );
  return a;
}

async function get(p: string): Promise<any> {
  const res = await fetch(`${api()}${p}`);
  if (!res.ok) throw new Error(`GET ${p}: ${res.status}`);
  return res.json();
}

/** This protocol's incidents touched since `since` (opened, or with a signature in `sigs`). */
export async function incidents(since: Date): Promise<any[]> {
  const { protocol } = fixtures();
  const items: any[] = (await get("/incidents?limit=500")).items;
  return items.filter(
    (i) => i.protocol === protocol && new Date(i.opened_at) >= since,
  );
}

/** Wait for an incident matching `pred` (opened since `since`). */
export async function waitIncident(
  since: Date,
  pred: (i: any) => boolean,
  ms = 30_000,
): Promise<any | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = (await incidents(since)).find(pred);
    if (hit) return hit;
    await sleep(500);
  }
  return undefined;
}

/** This protocol's guardian-bot actions since `since`. */
export async function botActions(since: Date, kind?: string): Promise<any[]> {
  const { protocol } = fixtures();
  const items: any[] = (
    await get(`/actions?limit=500${kind ? `&kind=${kind}` : ""}`)
  ).items;
  return items.filter(
    (a) => a.protocol === protocol && new Date(a.at) >= since,
  );
}

/** The program error name in a thrown Anchor/web3 error, or its message. */
export function errName(e: any): string {
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const text = [String(e?.message ?? e), ...logs].join("\n");
  return (
    e?.error?.errorCode?.code ??
    /Error Code: (\w+)/.exec(text)?.[1] ??
    text.split("\n")[0]
  );
}

/** Run `p`, expecting it to fail; returns the error name ("" if it succeeded). */
export async function failsWith(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "";
  } catch (e) {
    return errName(e);
  }
}

export async function balance(
  connection: Connection,
  account: PublicKey,
): Promise<bigint> {
  try {
    return BigInt(
      (await connection.getTokenAccountBalance(account, "confirmed")).value
        .amount,
    );
  } catch {
    return 0n;
  }
}

export const fmt = (base: bigint) => `${Number(base) / 1e6} tokens`;

/** Block time of a transaction, retrying until the RPC has indexed it. */
export async function blockTime(
  connection: Connection,
  sig: string,
): Promise<number> {
  for (let i = 0; i < 60; i++) {
    const tx = await connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx?.blockTime) return tx.blockTime;
    await sleep(500);
  }
  throw new Error(`transaction ${sig} not found`);
}

/** Print the one result line and exit. Any thrown error is a FAIL. */
export function attack(
  name: string,
  body: () => Promise<{ ok: boolean; msg: string }>,
) {
  body()
    .then(({ ok, msg }) => {
      console.log(`${ok ? "PASS" : "FAIL"}: ${name}: ${msg}`);
      process.exit(ok ? 0 : 1);
    })
    .catch((e) => {
      log(e);
      console.log(`FAIL: ${name}: the attack script crashed (${errName(e)})`);
      process.exit(1);
    });
}

/** Collects named checks; `ok` only if all pass. */
export class Checks {
  private failed: string[] = [];
  private passed: string[] = [];
  check(ok: boolean, what: string, detail = "") {
    (ok ? this.passed : this.failed).push(
      detail ? `${what} (${detail})` : what,
    );
    log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  }
  get ok() {
    return this.failed.length === 0;
  }
  summary(passMsg: string) {
    return { ok: this.ok, msg: this.ok ? passMsg : this.failed.join("; ") };
  }
}
