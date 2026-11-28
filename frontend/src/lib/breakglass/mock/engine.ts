/**
 * The mock chain: in-memory accounts that change the way the Breakglass
 * program and the test_vault protocol change them. Every method takes the
 * signer and the time explicitly, runs the same checks as the program (see
 * ../rules), and either applies the change and returns the emitted events,
 * or throws a RuleError (Breakglass) or a ProtocolError (test_vault, token)
 * and changes nothing.
 *
 * Synchronous on purpose: the seed data is built by replaying actions at
 * past times, and the tests drive it directly. MockClient wraps it in the
 * async BreakglassClient interface.
 */
import type {
  ConfigAction,
  FlowLimiter,
  GuardianLedger,
  HoldKind,
  PauseState,
  PendingConfig,
  PendingWithdrawal,
  Position,
  ProtocolConfig,
} from "../accounts.ts";
import { WINDOW_BUCKETS } from "../accounts.ts";
import type {
  ClaimResult,
  InitFlowLimiterArgs,
  InitializeConfigArgs,
  TxResult,
  WithdrawResult,
} from "../client.ts";
import {
  CONFIG_ACTION_CODES,
  DEFAULTS,
  MAX_GUARDIANS,
  scopeMask,
  TEST_VAULT_SCOPES,
  U64_MAX,
} from "../constants.ts";
import { require, RuleError } from "../errors.ts";
import type {
  BreakglassEvent,
  BreakglassEventRecord,
  EventDataByName,
} from "../events.ts";
import type { Incident, IncidentDetail, Severity } from "../monitor.ts";
import type {
  Address,
  ScopeMask,
  Seconds,
  Signature,
  U64,
  UnixSeconds,
} from "../primitives.ts";
import {
  autoTrip,
  applyPause,
  applyRenew,
  applyUnpause,
  isScopePaused,
  newLedger,
  roleOf,
} from "../rules/pauses.ts";
import {
  evaluate,
  roll,
  record,
  windowTotal,
  effectiveCap,
} from "../rules/limiter.ts";
import { mockAddress, mockSignature, randomU64 } from "./address.ts";

/** An error from the protected protocol or the token program, not Breakglass. */
export class ProtocolError extends Error {
  readonly errorName: string;
  readonly program: "protocol" | "token";
  constructor(
    errorName: string,
    program: "protocol" | "token",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
    this.errorName = errorName;
    this.program = program;
  }
}

/** Who signs and when. */
export type Ctx = { signer: Address; now: UnixSeconds };

/** The one protected protocol the mock knows: the test vault. */
export type TestVault = {
  /** The test_vault program (the protected program). */
  program: Address;
  /** Its vault account (what Position.vault points at). */
  vault: Address;
  /** The mint it holds, and its token account for that mint. */
  mint: Address;
  tokenAccount: Address;
  /** Who can sign as the program's upgrade authority. */
  upgradeAuthority: Address;
};

const ZERO = BigInt(0);

/** A user's token account for a mint (an associated token account). */
export const walletTokenAccount = (owner: Address, mint: Address) =>
  mockAddress(`ata:${owner}:${mint}`);

export const configAddress = (protectedProgram: Address) =>
  mockAddress(`config:${protectedProgram}`);

export class MockEngine {
  readonly testVault: TestVault;
  slot = 300_000_000;

  configs = new Map<Address, ProtocolConfig>();
  pauseStates = new Map<Address, { address: Address; account: PauseState }>();
  limiters = new Map<Address, FlowLimiter>();
  balances = new Map<Address, U64>();
  holds = new Map<Address, PendingWithdrawal>();
  changes = new Map<Address, PendingConfig>();
  ledgers = new Map<Address, GuardianLedger>();
  positions = new Map<string, Position>();
  events: BreakglassEventRecord[] = [];
  incidents: IncidentDetail[] = [];
  /** Demo programs "deployed" in the mock, and who their upgrade authority is. */
  programAuthorities = new Map<Address, Address>();

  constructor(testVault: TestVault) {
    this.testVault = testVault;
  }

  // Lookups ------------------------------------------------------------------

  config(address: Address): ProtocolConfig {
    const config = this.configs.get(address);
    if (!config)
      throw new ProtocolError(
        "AccountNotInitialized",
        "protocol",
        "No such protocol config.",
      );
    return config;
  }

  pauseState(config: Address): PauseState {
    const state = this.pauseStates.get(config);
    if (!state)
      throw new ProtocolError(
        "AccountNotInitialized",
        "protocol",
        "No pause state.",
      );
    return state.account;
  }

  limiterFor(config: Address, filter: (l: FlowLimiter) => boolean) {
    for (const [address, limiter] of this.limiters) {
      if (limiter.config === config && filter(limiter))
        return { address, limiter };
    }
    return null;
  }

  ledgerFor(config: Address, guardian: Address, now: UnixSeconds) {
    const address = mockAddress(`gledger:${config}:${guardian}`);
    return {
      address,
      ledger: this.ledgers.get(address) ?? newLedger(config, guardian, now),
    };
  }

  hold(config: Address, address: Address): PendingWithdrawal {
    const hold = this.holds.get(address);
    if (!hold || hold.config !== config) throw new RuleError("WrongHold");
    return hold;
  }

  balance(tokenAccount: Address): U64 {
    return this.balances.get(tokenAccount) ?? ZERO;
  }

  private move(from: Address | null, to: Address | null, amount: U64) {
    if (from) this.balances.set(from, this.balance(from) - amount);
    if (to) this.balances.set(to, this.balance(to) + amount);
  }

  positionKey = (vault: Address, owner: Address) => `${vault}:${owner}`;

  // Transactions ---------------------------------------------------------------

  /** Records a transaction's events and returns its result. */
  private commit(ctx: Ctx, events: BreakglassEvent[]): TxResult {
    const signature = mockSignature();
    this.slot += 1 + Math.floor(Math.random() * 3);
    for (const event of events) {
      this.events.unshift({
        event,
        signature,
        slot: this.slot,
        blockTime: ctx.now,
        signer: ctx.signer,
      });
    }
    this.detectIncidents(events, signature, ctx.now);
    return { signature, events };
  }

  /**
   * Runs `body` on copies of the state and keeps them only if it succeeds,
   * so a failed instruction changes nothing, as on chain.
   */
  private atomic<T>(body: () => T): T {
    const snapshot = structuredClone({
      configs: this.configs,
      pauseStates: this.pauseStates,
      limiters: this.limiters,
      balances: this.balances,
      holds: this.holds,
      changes: this.changes,
      ledgers: this.ledgers,
      positions: this.positions,
    });
    try {
      return body();
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    }
  }

  // Breakglass: config -------------------------------------------------------------

  initializeConfig(ctx: Ctx, args: InitializeConfigArgs): TxResult {
    return this.atomic(() => {
      const address = configAddress(args.protectedProgram);
      if (this.configs.has(address)) {
        throw new ProtocolError(
          "AccountAlreadyInUse",
          "protocol",
          "This protocol is already registered.",
        );
      }
      const authority =
        args.protectedProgram === this.testVault.program
          ? this.testVault.upgradeAuthority
          : (this.programAuthorities.get(args.protectedProgram) ?? null);
      require(ctx.signer === authority &&
        ctx.signer === args.admin, "Unauthorized");
      require(args.guardians.length <= MAX_GUARDIANS, "TooManyGuardians");
      const timelock = args.timelockSecs ?? DEFAULTS.timelockSecs;
      require(timelock >= DEFAULTS.minTimelockSecs &&
        timelock <= DEFAULTS.maxTimelockSecs, "InvalidTimelock");
      this.configs.set(address, {
        version: 1,
        bump: 255,
        protectedProgram: args.protectedProgram,
        admin: args.admin,
        guardians: [...args.guardians],
        unpausableMask: args.unpausableMask,
        policy: {
          maxGuardianPauseSecs: DEFAULTS.maxGuardianPauseSecs,
          maxRenewals: DEFAULTS.maxRenewals,
          cooldownSecs: DEFAULTS.cooldownSecs,
          budgetSecsPerPeriod: DEFAULTS.budgetSecsPerPeriod,
          budgetPeriodSecs: DEFAULTS.budgetPeriodSecs,
          autoTripSecs: DEFAULTS.autoTripSecs,
        },
        timelockSecs: timelock,
        nextChangeId: ZERO,
      });
      this.pauseStates.set(address, {
        address: mockAddress(`pause:${address}`),
        account: { bump: 255, config: address, active: [] },
      });
      return this.commit(ctx, [
        {
          name: "configInitialized",
          data: {
            config: address,
            protectedProgram: args.protectedProgram,
            admin: args.admin,
            guardians: [...args.guardians],
          },
        },
      ]);
    });
  }

  initFlowLimiter(ctx: Ctx, args: InitFlowLimiterArgs): TxResult {
    return this.atomic(() => {
      const config = this.config(args.config);
      require(ctx.signer === config.admin, "Unauthorized");
      const address = mockAddress(`flow:${args.config}:${args.mint}`);
      if (this.limiters.has(address)) {
        throw new ProtocolError(
          "AccountAlreadyInUse",
          "protocol",
          "This mint already has a limiter.",
        );
      }
      const limiter: FlowLimiter = {
        bump: 255,
        config: args.config,
        mint: args.mint,
        vault: args.vault,
        scope: args.scope,
        windowSecs: args.windowSecs ?? DEFAULTS.windowSecs,
        capAbsolute: args.capAbsolute,
        capBpsOfVault: args.capBpsOfVault,
        buckets: Array.from({ length: WINDOW_BUCKETS }, () => ZERO),
        bucketStart: 0,
        largeThreshold: args.largeThreshold,
        largeThresholdBps: args.largeThresholdBps,
        holdSecs: args.holdSecs ?? DEFAULTS.holdSecs,
        autoTripSecs: args.autoTripSecs ?? config.policy.autoTripSecs,
        instantAllowance: args.instantAllowance ?? U64_MAX,
        screenSecs: args.screenSecs ?? DEFAULTS.screenSecs,
      };
      validateLimiter(limiter);
      require((scopeMask(args.scope) & config.unpausableMask) ===
        ZERO, "ScopeUnpausable");
      roll(limiter, ctx.now);
      this.limiters.set(address, limiter);
      return this.commit(ctx, []);
    });
  }

  removeGuardian(ctx: Ctx, configAddr: Address, guardian: Address): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      require(ctx.signer === config.admin, "Unauthorized");
      require(config.guardians.includes(guardian), "GuardianNotFound");
      config.guardians = config.guardians.filter((g) => g !== guardian);
      return this.commit(ctx, [
        { name: "guardianRemoved", data: { config: configAddr, guardian } },
      ]);
    });
  }

  // Breakglass: pauses -------------------------------------------------------------

  pause(
    ctx: Ctx,
    configAddr: Address,
    mask: ScopeMask,
    duration: Seconds,
    reason: number,
  ): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      const { address, ledger } = this.ledgerFor(
        configAddr,
        ctx.signer,
        ctx.now,
      );
      const out = applyPause(
        this.pauseState(configAddr),
        ledger,
        config,
        ctx.signer,
        mask,
        duration,
        reason,
        ctx.now,
      );
      this.ledgers.set(address, ledger);
      const kind =
        out.kind === "guardian" ? 0 : out.kind === "autoTrip" ? 1 : 2;
      return this.commit(ctx, [
        {
          name: "paused",
          data: {
            config: configAddr,
            scopesMask: mask,
            pausedUntil: out.pausedUntil,
            by: ctx.signer,
            kind,
            reason,
          },
        },
      ]);
    });
  }

  renewPause(ctx: Ctx, configAddr: Address, mask: ScopeMask): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      const { address, ledger } = this.ledgerFor(
        configAddr,
        ctx.signer,
        ctx.now,
      );
      const out = applyRenew(
        this.pauseState(configAddr),
        ledger,
        config,
        ctx.signer,
        mask,
        ctx.now,
      );
      this.ledgers.set(address, ledger);
      return this.commit(ctx, [
        {
          name: "pauseRenewed",
          data: {
            config: configAddr,
            scopesMask: mask,
            pausedUntil: out.pausedUntil,
            by: ctx.signer,
            renewals: out.renewals,
          },
        },
      ]);
    });
  }

  unpause(ctx: Ctx, configAddr: Address, mask: ScopeMask): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      const lifted = applyUnpause(
        this.pauseState(configAddr),
        config,
        ctx.signer,
        mask,
        ctx.now,
      );
      return this.commit(ctx, [
        {
          name: "unpaused",
          data: { config: configAddr, scopesMask: lifted, by: ctx.signer },
        },
      ]);
    });
  }

  // Breakglass: holds ----------------------------------------------------------------

  freezeHeld(ctx: Ctx, configAddr: Address, holdAddr: Address): TxResult {
    return this.atomic(() => {
      roleOf(this.config(configAddr), ctx.signer);
      const hold = this.hold(configAddr, holdAddr);
      require(hold.status === "queued", "HoldInvalidState");
      hold.status = "frozen";
      return this.commit(ctx, [
        {
          name: "holdFrozen",
          data: { config: configAddr, hold: holdAddr, by: ctx.signer },
        },
      ]);
    });
  }

  /** Through the protocol: the amount returns to the user's position. */
  rejectHeld(ctx: Ctx, configAddr: Address, holdAddr: Address): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      require(ctx.signer === config.admin, "Unauthorized");
      const hold = this.hold(configAddr, holdAddr);
      require(hold.status === "queued" ||
        hold.status === "frozen" ||
        hold.status === "released", "HoldInvalidState");
      hold.status = "rejected";
      const position = this.positionOf(hold.owner);
      position.held -= hold.amount;
      position.amount += hold.amount;
      return this.commit(ctx, [
        {
          name: "holdResolved",
          data: { config: configAddr, hold: holdAddr, outcome: 2 },
        },
      ]);
    });
  }

  /** Through the protocol, signed by the hold's owner. */
  claimHeld(ctx: Ctx, configAddr: Address, holdAddr: Address): ClaimResult {
    return this.atomic(() => {
      const hold = this.hold(configAddr, holdAddr);
      require(ctx.signer === hold.owner, "Unauthorized");
      if (hold.status === "queued")
        require(ctx.now >= hold.releaseAt, "HoldNotReleased");
      else if (hold.status === "frozen") throw new RuleError("HoldFrozen");
      else if (hold.status !== "released")
        throw new RuleError("HoldInvalidState");
      const state = this.pauseState(configAddr);
      require(!isScopePaused(state.active, hold.scope, ctx.now), "ScopePaused");

      const found = this.limiterFor(configAddr, (l) => l.mint === hold.mint);
      if (!found) throw new RuleError("WrongHold");
      const { address: limiterAddr, limiter } = found;
      const balance = this.balance(limiter.vault);

      let total: U64;
      let cap: U64;
      if (hold.status === "released") {
        // Released through the timelock: not capped again, but recorded.
        roll(limiter, ctx.now);
        record(limiter, hold.amount);
        total = windowTotal(limiter);
        cap = effectiveCap(limiter, balance);
      } else {
        const verdict = evaluate(limiter, hold.amount, balance, ctx.now, true);
        if (verdict.kind === "holdBreach") {
          const events = this.trip(
            configAddr,
            limiterAddr,
            limiter,
            state,
            verdict,
            ctx.now,
          );
          return { ...this.commit(ctx, events), decision: "hold" as const };
        }
        if (verdict.kind !== "allow")
          throw new Error("Claims skip the threshold and screening.");
        total = verdict.windowTotal;
        cap = verdict.windowCap;
      }

      hold.status = "claimed";
      const position = this.positionOf(hold.owner);
      position.held -= hold.amount;
      this.move(
        limiter.vault,
        walletTokenAccount(hold.owner, hold.mint),
        hold.amount,
      );
      return {
        ...this.commit(ctx, [
          {
            name: "holdResolved",
            data: { config: configAddr, hold: holdAddr, outcome: 0 },
          },
          {
            name: "outflowRecorded",
            data: {
              config: configAddr,
              mint: hold.mint,
              owner: hold.owner,
              amount: hold.amount,
              windowTotal: total,
              windowCap: cap,
            },
          },
        ]),
        decision: "allow" as const,
      };
    });
  }

  /** Auto-trips the limiter's scope and returns the two events it emits. */
  private trip(
    configAddr: Address,
    limiterAddr: Address,
    limiter: FlowLimiter,
    state: PauseState,
    verdict: { windowTotal: U64; windowCap: U64 },
    now: UnixSeconds,
  ): BreakglassEvent[] {
    const pausedUntil = autoTrip(state, limiterAddr, limiter, now);
    return [
      {
        name: "limitTripped",
        data: {
          config: configAddr,
          mint: limiter.mint,
          scope: limiter.scope,
          windowTotal: verdict.windowTotal,
          windowCap: verdict.windowCap,
          pausedUntil,
        },
      },
      {
        name: "paused",
        data: {
          config: configAddr,
          scopesMask: scopeMask(limiter.scope),
          pausedUntil,
          by: limiterAddr,
          kind: 1,
          reason: 1,
        },
      },
    ];
  }

  // Breakglass: timelocked changes (backend phase 4, provisional) --------------------

  proposeConfig(ctx: Ctx, configAddr: Address, action: ConfigAction): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      require(ctx.signer === config.admin, "Unauthorized");
      if (action.kind === "releaseHeld") {
        const hold = this.hold(configAddr, action.hold);
        require(hold.status === "queued" ||
          hold.status === "frozen", "HoldInvalidState");
      }
      if (action.kind === "addGuardian") {
        require(config.guardians.length < MAX_GUARDIANS, "TooManyGuardians");
      }
      const id = config.nextChangeId;
      config.nextChangeId = id + BigInt(1);
      const address = mockAddress(`cfgchg:${configAddr}:${id}`);
      const executableAt = ctx.now + config.timelockSecs;
      this.changes.set(address, {
        bump: 255,
        config: configAddr,
        id,
        action: structuredClone(action),
        proposedAt: ctx.now,
        executableAt,
        vetoed: false,
        executed: false,
      });
      return this.commit(ctx, [
        {
          name: "configChangeProposed",
          data: {
            config: configAddr,
            change: address,
            actionKind: CONFIG_ACTION_CODES[action.kind],
            executableAt,
          },
        },
      ]);
    });
  }

  private change(configAddr: Address, address: Address): PendingConfig {
    const change = this.changes.get(address);
    if (!change || change.config !== configAddr) {
      throw new ProtocolError(
        "AccountNotInitialized",
        "protocol",
        "No such pending change.",
      );
    }
    return change;
  }

  executeConfig(ctx: Ctx, configAddr: Address, changeAddr: Address): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      const change = this.change(configAddr, changeAddr);
      require(!change.executed, "NotExecutable");
      require(!change.vetoed, "Vetoed");
      require(ctx.now >= change.executableAt, "TimelockActive");
      const events: BreakglassEvent[] = [];
      const action = change.action;
      switch (action.kind) {
        case "raiseLimits": {
          const found = this.limiterFor(
            configAddr,
            (l) => l.mint === action.mint,
          );
          if (!found) throw new RuleError("InvalidLimiterConfig");
          Object.assign(found.limiter, {
            capAbsolute: action.capAbsolute,
            capBpsOfVault: action.capBpsOfVault,
            largeThreshold: action.largeThreshold,
            largeThresholdBps: action.largeThresholdBps,
          });
          validateLimiter(found.limiter);
          break;
        }
        case "addGuardian":
          require(config.guardians.length < MAX_GUARDIANS, "TooManyGuardians");
          if (!config.guardians.includes(action.guardian))
            config.guardians.push(action.guardian);
          break;
        case "setAdmin":
          config.admin = action.admin;
          break;
        case "releaseHeld": {
          const hold = this.hold(configAddr, action.hold);
          require(hold.status === "queued" ||
            hold.status === "frozen", "HoldInvalidState");
          hold.status = "released";
          events.push({
            name: "holdResolved",
            data: { config: configAddr, hold: action.hold, outcome: 1 },
          });
          break;
        }
        case "changePolicy":
          config.policy = { ...action.policy };
          break;
      }
      change.executed = true;
      return this.commit(ctx, [
        {
          name: "configChangeExecuted",
          data: { config: configAddr, change: changeAddr },
        },
        ...events,
      ]);
    });
  }

  vetoConfig(ctx: Ctx, configAddr: Address, changeAddr: Address): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      require(roleOf(config, ctx.signer) === "guardian", "Unauthorized");
      const change = this.change(configAddr, changeAddr);
      require(!change.executed && !change.vetoed, "NotExecutable");
      change.vetoed = true;
      return this.commit(ctx, [
        {
          name: "configChangeVetoed",
          data: { config: configAddr, change: changeAddr, by: ctx.signer },
        },
      ]);
    });
  }

  /** Admin withdraws its own proposal; the account closes. */
  cancelConfig(ctx: Ctx, configAddr: Address, changeAddr: Address): TxResult {
    return this.atomic(() => {
      const config = this.config(configAddr);
      require(ctx.signer === config.admin, "Unauthorized");
      const change = this.change(configAddr, changeAddr);
      require(!change.executed, "NotExecutable");
      this.changes.delete(changeAddr);
      return this.commit(ctx, []);
    });
  }

  // The test vault ---------------------------------------------------------------------

  private get testConfig(): Address {
    return configAddress(this.testVault.program);
  }

  private positionOf(owner: Address): Position {
    const key = this.positionKey(this.testVault.vault, owner);
    let position = this.positions.get(key);
    if (!position) {
      position = {
        owner,
        vault: this.testVault.vault,
        amount: ZERO,
        held: ZERO,
      };
      this.positions.set(key, position);
    }
    return position;
  }

  private requireTestVault(vault: Address) {
    if (vault !== this.testVault.vault) {
      throw new ProtocolError(
        "WrongVault",
        "protocol",
        "That isn't the test vault.",
      );
    }
  }

  /** Deposit: the protocol checks the DEPOSIT scope (check_scope), then moves tokens. */
  deposit(ctx: Ctx, vault: Address, amount: U64): TxResult {
    return this.atomic(() => {
      this.requireTestVault(vault);
      const config = this.testConfig;
      require(!isScopePaused(
        this.pauseState(config).active,
        TEST_VAULT_SCOPES.deposit,
        ctx.now,
      ), "ScopePaused");
      const from = walletTokenAccount(ctx.signer, this.testVault.mint);
      if (amount <= ZERO || this.balance(from) < amount) {
        throw new ProtocolError(
          "InsufficientFunds",
          "token",
          "Not enough tokens in your wallet.",
        );
      }
      this.move(from, this.testVault.tokenAccount, amount);
      this.positionOf(ctx.signer).amount += amount;
      return this.commit(ctx, []);
    });
  }

  /** Withdraw: the protocol asks the gate (check_outflow) before paying out. */
  withdraw(ctx: Ctx, vault: Address, amount: U64): WithdrawResult {
    return this.atomic(() => {
      this.requireTestVault(vault);
      const configAddr = this.testConfig;
      const position = this.positionOf(ctx.signer);
      if (amount <= ZERO || position.amount < amount) {
        throw new ProtocolError(
          "InsufficientPosition",
          "protocol",
          "That's more than your position.",
        );
      }
      const found = this.limiterFor(
        configAddr,
        (l) => l.mint === this.testVault.mint,
      );
      if (!found) throw new RuleError("WrongVault");
      const { address: limiterAddr, limiter } = found;
      const state = this.pauseState(configAddr);
      require(!isScopePaused(
        state.active,
        limiter.scope,
        ctx.now,
      ), "ScopePaused");

      const balance = this.balance(limiter.vault);
      const verdict = evaluate(limiter, amount, balance, ctx.now, false);
      if (verdict.kind === "allow") {
        position.amount -= amount;
        this.move(
          limiter.vault,
          walletTokenAccount(ctx.signer, limiter.mint),
          amount,
        );
        return {
          ...this.commit(ctx, [
            {
              name: "outflowRecorded",
              data: {
                config: configAddr,
                mint: limiter.mint,
                owner: ctx.signer,
                amount,
                windowTotal: verdict.windowTotal,
                windowCap: verdict.windowCap,
              },
            },
          ]),
          decision: "allow" as const,
        };
      }

      const events: BreakglassEvent[] = [];
      let kind: HoldKind;
      let secs: Seconds;
      if (verdict.kind === "holdBreach") {
        events.push(
          ...this.trip(
            configAddr,
            limiterAddr,
            limiter,
            state,
            verdict,
            ctx.now,
          ),
        );
        kind = "limit";
        secs = limiter.holdSecs;
      } else if (verdict.kind === "holdLarge") {
        kind = "large";
        secs = limiter.holdSecs;
      } else {
        kind = "screen";
        secs = limiter.screenSecs;
      }

      const nonce = randomU64();
      const holdAddr = mockAddress(`hold:${configAddr}:${ctx.signer}:${nonce}`);
      const releaseAt = ctx.now + secs;
      this.holds.set(holdAddr, {
        bump: 255,
        config: configAddr,
        owner: ctx.signer,
        mint: limiter.mint,
        amount,
        nonce,
        createdAt: ctx.now,
        releaseAt,
        status: "queued",
        scope: limiter.scope,
        kind,
      });
      position.amount -= amount;
      position.held += amount;
      const data = {
        config: configAddr,
        hold: holdAddr,
        mint: limiter.mint,
        owner: ctx.signer,
        amount,
        releaseAt,
      };
      const name =
        kind === "large"
          ? "largeWithdrawalQueued"
          : kind === "limit"
            ? "limitHoldQueued"
            : "withdrawalScreenQueued";
      events.push({ name, data } as BreakglassEvent);
      return {
        ...this.commit(ctx, events),
        decision: "hold" as const,
        hold: holdAddr,
        releaseAt,
      };
    });
  }

  // Monitor ------------------------------------------------------------------------------

  /** Opens incidents the way the monitor's detectors would. */
  private detectIncidents(
    events: BreakglassEvent[],
    signature: Signature,
    now: UnixSeconds,
  ) {
    const open = (detector: string, severity: Severity, title: string) => {
      const incident: Incident = {
        id: `inc_${this.incidents.length + 1}`,
        protocol: this.testVault.program,
        detector,
        severity,
        title,
        status: "open",
        opened_at: new Date(now * 1000).toISOString(),
        acked_by: null,
        acked_at: null,
        signatures: [signature],
      };
      this.incidents.unshift({
        ...incident,
        events: events.map((event, i) => ({
          id: `${signature}:${i}`,
          kind: event.name,
          signature,
          slot: this.slot,
          block_time: incident.opened_at,
          data: jsonSafe(event.data),
        })),
        alerts: [
          {
            id: `${incident.id}:pager`,
            sink: "pager",
            sent_at: incident.opened_at,
            ok: true,
          },
        ],
      });
    };
    for (const event of events) {
      switch (event.name) {
        case "limitTripped":
          open(
            "limit-trip",
            "critical",
            "Withdrawal cap hit: withdrawals auto-paused",
          );
          break;
        case "largeWithdrawalQueued":
          open("large-withdrawal", "warning", "Large withdrawal held");
          break;
        case "paused":
          if (event.data.kind === 0)
            open("guardian-pause", "high", "Guardian paused a scope");
          break;
        case "configChangeProposed":
          open("config-change", "high", "Config change proposed");
          break;
      }
    }
  }
}

/** Limiter parameter checks (validate_params in limiter.rs). */
function validateLimiter(l: FlowLimiter) {
  require(l.windowSecs >= WINDOW_BUCKETS &&
    l.capAbsolute > ZERO &&
    l.capBpsOfVault <= 10_000 &&
    l.largeThresholdBps <= 10_000 &&
    l.holdSecs > 0 &&
    l.autoTripSecs > 0 &&
    l.screenSecs > 0, "InvalidLimiterConfig");
}

/** Event fields as the monitor's JSON carries them: u64 as decimal strings. */
function jsonSafe(
  data: EventDataByName[keyof EventDataByName],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      typeof v === "bigint" ? v.toString() : v,
    ]),
  );
}
