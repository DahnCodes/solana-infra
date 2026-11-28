/**
 * BreakglassClient in mock mode: the MockEngine behind the async interface,
 * plus what a demo needs that a chain doesn't have: a wallet switcher, a
 * clock that can be fast-forwarded, and a short delay on every call so
 * loading and pending states show.
 */
import type { HoldStatus } from "../accounts.ts";
import type {
  AccountRecord,
  BreakglassClient,
  PageOptions,
} from "../client.ts";
import type { Incident, IncidentDetail } from "../monitor.ts";
import { BREAKGLASS_ERRORS, clientError, RuleError } from "../errors.ts";
import type { Address, Seconds, UnixSeconds } from "../primitives.ts";
import { mockAddress } from "./address.ts";
import {
  configAddress,
  MockEngine,
  ProtocolError,
  type Ctx,
  type TestVault,
  walletTokenAccount,
} from "./engine.ts";
import { MOCK_WALLETS, seedDemo } from "./seed.ts";

export type MockClientOptions = {
  /** The Breakglass program id (errors name it as the failing program). */
  breakglassProgram: Address;
  testVault: TestVault;
  /** Delay on each call, in ms (0 in tests). */
  latencyMs?: number;
  /** Start from the demo state (default) or empty. */
  seed?: boolean;
  /** Real time in ms; the simulated clock runs from it. */
  realNow?: () => number;
};

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** An incident without its events and alerts, as list endpoints return it. */
function summary(detail: IncidentDetail): Incident {
  return {
    id: detail.id,
    protocol: detail.protocol,
    detector: detail.detector,
    severity: detail.severity,
    title: detail.title,
    status: detail.status,
    opened_at: detail.opened_at,
    acked_by: detail.acked_by,
    acked_at: detail.acked_at,
    signatures: detail.signatures,
  };
}

/** The test vault the mock simulates, from the configured program and mint. */
export function mockTestVault(
  program: Address,
  mint: Address | null,
): TestVault {
  const usdcMint = mint ?? mockAddress("mint:usdc");
  const vault = mockAddress(`vault:${program}`);
  return {
    program,
    vault,
    mint: usdcMint,
    tokenAccount: mockAddress(`ata:${vault}:${usdcMint}`),
    upgradeAuthority: MOCK_WALLETS.admin.address,
  };
}

export class MockClient implements BreakglassClient {
  private engine: MockEngine;
  private offset: Seconds = 0;
  private wallet: Address | null = MOCK_WALLETS.user.address;
  private listeners = new Set<() => void>();
  private readonly options: Required<Omit<MockClientOptions, "seed">> & {
    seed: boolean;
  };

  constructor(options: MockClientOptions) {
    this.options = {
      latencyMs: 350,
      seed: true,
      realNow: () => Date.now(),
      ...options,
    };
    this.engine = this.freshEngine();
  }

  private freshEngine(): MockEngine {
    const engine = new MockEngine(this.options.testVault);
    if (this.options.seed) seedDemo(engine, this.now());
    return engine;
  }

  // Mock-only controls ---------------------------------------------------------

  /** The simulated time, in unix seconds. */
  now(): UnixSeconds {
    return Math.floor(this.options.realNow() / 1000) + this.offset;
  }

  /** How far the simulated clock is ahead of real time. */
  get clockOffset(): Seconds {
    return this.offset;
  }

  /** Fast-forward the simulated clock (holds unlock, pauses expire). */
  advanceClock(seconds: Seconds): void {
    this.offset += seconds;
    this.notify();
  }

  get connectedWallet(): Address | null {
    return this.wallet;
  }

  private outage = false;

  /** Whether reads are failing on purpose (the demo's outage switch). */
  get simulatingOutage(): boolean {
    return this.outage;
  }

  /** Make every read fail, to show what screens do when the network is down. */
  setOutage(on: boolean): void {
    this.outage = on;
    this.notify();
  }

  /** Act as another wallet (the demo's role switcher). */
  setWallet(address: Address | null): void {
    this.wallet = address;
    this.notify();
  }

  /** Back to the demo state at the current real time. */
  reset(): void {
    this.offset = 0;
    this.engine = this.freshEngine();
    this.notify();
  }

  get testVault(): TestVault {
    return this.options.testVault;
  }

  /**
   * "Deploys" a fresh demo program whose upgrade authority is the connected
   * wallet, so the register flow can be tried end to end. Returns the program
   * plus a token mint and a vault token account holding 500,000 tokens.
   */
  async createDemoProgram(): Promise<{
    program: Address;
    mint: Address;
    vault: Address;
  }> {
    await this.delay();
    if (!this.wallet) {
      throw clientError("Connect a wallet first.", {
        errorName: "WalletNotConnected",
      });
    }
    const n = this.engine.programAuthorities.size + 1;
    const program = mockAddress(
      `demo-program:${this.wallet}:${n}:${this.now()}`,
    );
    const mint = this.options.testVault.mint;
    const vault = mockAddress(`ata:${program}:${mint}`);
    this.engine.programAuthorities.set(program, this.wallet);
    this.engine.balances.set(vault, BigInt(500_000) * BigInt(1_000_000));
    this.notify();
    return { program, mint, vault };
  }

  /**
   * The test-token faucet: credits mock USDC to the connected wallet's token
   * account, so a new wallet can deposit and withdraw at once.
   */
  async requestTestTokens(amount: bigint): Promise<void> {
    await this.delay();
    if (!this.wallet) {
      throw clientError("Connect a wallet first.", {
        errorName: "WalletNotConnected",
      });
    }
    const account = walletTokenAccount(
      this.wallet,
      this.options.testVault.mint,
    );
    this.engine.balances.set(account, this.engine.balance(account) + amount);
    this.notify();
  }

  // Plumbing ---------------------------------------------------------------------

  private delay(factor = 1): Promise<void> {
    const ms = this.options.latencyMs * factor;
    return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private async read<T>(get: () => T): Promise<T> {
    await this.delay(0.3);
    if (this.outage) {
      throw clientError("Couldn't reach the network (simulated outage).", {
        errorName: "NetworkUnavailable",
      });
    }
    return structuredClone(get());
  }

  /** Runs a write as the connected wallet, mapping failures to ClientError. */
  private async write<T>(run: (ctx: Ctx) => T): Promise<T> {
    await this.delay();
    if (!this.wallet) {
      throw clientError("Connect a wallet first.", {
        errorName: "WalletNotConnected",
      });
    }
    try {
      const result = run({ signer: this.wallet, now: this.now() });
      this.notify();
      return structuredClone(result);
    } catch (error) {
      if (error instanceof RuleError) {
        throw clientError(error.errorName, {
          code: BREAKGLASS_ERRORS[error.errorName],
          errorName: error.errorName,
          program: this.options.breakglassProgram,
        });
      }
      if (error instanceof ProtocolError) {
        throw clientError(error.message, {
          errorName: error.errorName,
          program:
            error.program === "token"
              ? TOKEN_PROGRAM
              : this.options.testVault.program,
        });
      }
      throw error;
    }
  }

  private records<T>(
    map: Map<Address, T>,
    keep: (a: T) => boolean,
  ): AccountRecord<T>[] {
    return [...map]
      .filter(([, a]) => keep(a))
      .map(([address, account]) => ({ address, account }));
  }

  // Reads: chain -------------------------------------------------------------------

  getClock() {
    return this.read(() => this.now());
  }

  listConfigs() {
    return this.read(() => this.records(this.engine.configs, () => true));
  }

  getConfig(protectedProgram: Address) {
    return this.read(() => {
      const address = configAddress(protectedProgram);
      const account = this.engine.configs.get(address);
      return account ? { address, account } : null;
    });
  }

  getPauseState(config: Address) {
    return this.read(() => this.engine.pauseStates.get(config) ?? null);
  }

  listFlowLimiters(config: Address) {
    return this.read(() =>
      this.records(this.engine.limiters, (l) => l.config === config),
    );
  }

  getTokenBalance(tokenAccount: Address) {
    return this.read(() => this.engine.balance(tokenAccount));
  }

  listHolds(
    config: Address,
    filter: {
      owner?: Address;
      status?: HoldStatus;
    } = {},
  ) {
    return this.read(() =>
      this.records(
        this.engine.holds,
        (h) =>
          h.config === config &&
          (!filter.owner || h.owner === filter.owner) &&
          (!filter.status || h.status === filter.status),
      ).sort((a, b) => b.account.createdAt - a.account.createdAt),
    );
  }

  listPendingChanges(config: Address) {
    return this.read(() =>
      this.records(this.engine.changes, (c) => c.config === config).sort(
        (a, b) => b.account.proposedAt - a.account.proposedAt,
      ),
    );
  }

  getGuardianLedger(config: Address, guardian: Address) {
    return this.read(() => {
      const address = mockAddress(`gledger:${config}:${guardian}`);
      const account = this.engine.ledgers.get(address);
      return account ? { address, account } : null;
    });
  }

  getPosition(vault: Address, owner: Address) {
    return this.read(
      () =>
        this.engine.positions.get(this.engine.positionKey(vault, owner)) ??
        null,
    );
  }

  listEvents(config: Address, options: PageOptions = {}) {
    return this.read(() => {
      const all = this.engine.events.filter(
        (r) => r.event.data.config === config,
      );
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = Math.min(options.limit ?? 50, 500);
      const items = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : null;
      return { items, nextCursor: next };
    });
  }

  // Reads: monitor -----------------------------------------------------------------

  listIncidents(status?: "open" | "acked" | "resolved") {
    return this.read(() =>
      this.engine.incidents
        .filter((i) => !status || i.status === status)
        .map(summary),
    );
  }

  getIncident(id: string) {
    return this.read(
      () => this.engine.incidents.find((i) => i.id === id) ?? null,
    );
  }

  // Writes ---------------------------------------------------------------------------

  initializeConfig(args: Parameters<BreakglassClient["initializeConfig"]>[0]) {
    return this.write((ctx) => this.engine.initializeConfig(ctx, args));
  }

  pause(args: Parameters<BreakglassClient["pause"]>[0]) {
    return this.write((ctx) =>
      this.engine.pause(
        ctx,
        args.config,
        args.scopes,
        args.duration,
        args.reason,
      ),
    );
  }

  renewPause(args: Parameters<BreakglassClient["renewPause"]>[0]) {
    return this.write((ctx) =>
      this.engine.renewPause(ctx, args.config, args.scopes),
    );
  }

  unpause(args: Parameters<BreakglassClient["unpause"]>[0]) {
    return this.write((ctx) =>
      this.engine.unpause(ctx, args.config, args.scopes),
    );
  }

  removeGuardian(args: Parameters<BreakglassClient["removeGuardian"]>[0]) {
    return this.write((ctx) =>
      this.engine.removeGuardian(ctx, args.config, args.guardian),
    );
  }

  initFlowLimiter(args: Parameters<BreakglassClient["initFlowLimiter"]>[0]) {
    return this.write((ctx) => this.engine.initFlowLimiter(ctx, args));
  }

  freezeHeld(args: Parameters<BreakglassClient["freezeHeld"]>[0]) {
    return this.write((ctx) =>
      this.engine.freezeHeld(ctx, args.config, args.hold),
    );
  }

  rejectHeld(args: Parameters<BreakglassClient["rejectHeld"]>[0]) {
    return this.write((ctx) =>
      this.engine.rejectHeld(ctx, args.config, args.hold),
    );
  }

  claimHeld(args: Parameters<BreakglassClient["claimHeld"]>[0]) {
    return this.write((ctx) =>
      this.engine.claimHeld(ctx, args.config, args.hold),
    );
  }

  /** Release goes through the timelock: it proposes a releaseHeld change. */
  releaseHeld(args: Parameters<BreakglassClient["releaseHeld"]>[0]) {
    return this.write((ctx) =>
      this.engine.proposeConfig(ctx, args.config, {
        kind: "releaseHeld",
        hold: args.hold,
      }),
    );
  }

  tightenLimits(args: Parameters<BreakglassClient["tightenLimits"]>[0]) {
    return this.write((ctx) =>
      this.engine.tightenLimits(ctx, args.config, args.mint, args.params),
    );
  }

  proposeConfig(args: Parameters<BreakglassClient["proposeConfig"]>[0]) {
    return this.write((ctx) =>
      this.engine.proposeConfig(ctx, args.config, args.action),
    );
  }

  executeConfig(args: Parameters<BreakglassClient["executeConfig"]>[0]) {
    return this.write((ctx) =>
      this.engine.executeConfig(ctx, args.config, args.change),
    );
  }

  vetoConfig(args: Parameters<BreakglassClient["vetoConfig"]>[0]) {
    return this.write((ctx) =>
      this.engine.vetoConfig(ctx, args.config, args.change),
    );
  }

  cancelConfig(args: Parameters<BreakglassClient["cancelConfig"]>[0]) {
    return this.write((ctx) =>
      this.engine.cancelConfig(ctx, args.config, args.change),
    );
  }

  deposit(args: Parameters<BreakglassClient["deposit"]>[0]) {
    return this.write((ctx) =>
      this.engine.deposit(ctx, args.vault, args.amount),
    );
  }

  withdraw(args: Parameters<BreakglassClient["withdraw"]>[0]) {
    return this.write((ctx) =>
      this.engine.withdraw(ctx, args.vault, args.amount),
    );
  }

  async ackIncident(id: string, request: { by: string; note?: string }) {
    await this.delay();
    const incident = this.engine.incidents.find((i) => i.id === id);
    if (!incident)
      throw clientError("No such incident.", { errorName: "not_found" });
    incident.status = "acked";
    incident.acked_by = request.by;
    incident.acked_at = new Date(this.now() * 1000).toISOString();
    this.notify();
    return summary(structuredClone(incident));
  }

  // Changes ------------------------------------------------------------------------------

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => {
      this.listeners.delete(onChange);
    };
  }
}
