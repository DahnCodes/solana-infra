/**
 * The one interface every screen reads and writes Breakglass through.
 *
 * Two implementations follow it: the mock client (step 2.3: in-memory state
 * and a simulated clock that apply the program's rules) and the live client
 * (phase 6: the devnet program, the test_vault program and the monitor
 * API). NEXT_PUBLIC_DATA_MODE picks one; screens never know which.
 *
 * Writes sign with the connected wallet. They resolve once the transaction
 * is confirmed and reject with a ClientError when it fails. Reads return
 * the data model in this folder (bigint amounts, base58 keys).
 */
import type {
  ConfigAction,
  FlowLimiter,
  GuardianLedger,
  HoldStatus,
  PauseState,
  PendingConfig,
  PendingWithdrawal,
  Position,
  ProtocolConfig,
} from "./accounts.ts";
import type { BreakglassEvent, BreakglassEventRecord } from "./events.ts";
import type {
  AckRequest,
  Incident,
  IncidentDetail,
  IncidentStatus,
} from "./monitor.ts";
import type {
  Address,
  Bps,
  ScopeId,
  ScopeMask,
  Seconds,
  Signature,
  U64,
  UnixSeconds,
} from "./primitives.ts";

// Shared shapes --------------------------------------------------------------

/** An account together with its on-chain address. */
export type AccountRecord<T> = { address: Address; account: T };

/** What every confirmed write returns. */
export type TxResult = {
  signature: Signature;
  /** The Breakglass events the transaction emitted, in order. */
  events: BreakglassEvent[];
};

/** The gate's answer to a withdrawal, with the hold it created if any. */
export type WithdrawResult = TxResult &
  (
    | { decision: "allow" }
    | { decision: "hold"; hold: Address; releaseAt: UnixSeconds }
  );

/** The gate's answer to a claim: paid out, or held again by the cap. */
export type ClaimResult = TxResult & { decision: "allow" | "hold" };

/**
 * A failed write. `program` says which program failed: Breakglass and the
 * protected protocol both number their errors from 6000 (see FRONTEND.md
 * section 8). Readable messages arrive in step 5.4.
 */
export type ClientError = Error & {
  code: number | null;
  /** The program error's name, such as "ScopePaused". */
  errorName: string | null;
  program: Address | null;
};

/** Paging for lists that grow without bound. */
export type PageOptions = { limit?: number; cursor?: string | null };

/** A page of results and the cursor for the next one. */
export type Paged<T> = { items: T[]; nextCursor: string | null };

// Write arguments ------------------------------------------------------------

/** Every Breakglass write that acts on one protocol names its config. */
type OnConfig = { config: Address };

export type InitializeConfigArgs = {
  /** The program being protected. Its upgrade authority must sign. */
  protectedProgram: Address;
  admin: Address;
  /** At most 5. */
  guardians: Address[];
  unpausableMask: ScopeMask;
  /** null = the program's default (48h). */
  timelockSecs: Seconds | null;
};

export type InitFlowLimiterArgs = OnConfig & {
  mint: Address;
  /** The protocol's vault token account for `mint`. */
  vault: Address;
  scope: ScopeId;
  capAbsolute: U64;
  capBpsOfVault: Bps;
  largeThreshold: U64;
  largeThresholdBps: Bps;
  /** Each null takes the program's default. */
  windowSecs: Seconds | null;
  holdSecs: Seconds | null;
  autoTripSecs: Seconds | null;
  instantAllowance: U64 | null;
  screenSecs: Seconds | null;
};

export type PauseArgs = OnConfig & {
  scopes: ScopeMask;
  duration: Seconds;
  /** Free-form reason code (u16). */
  reason: number;
};

export type ScopesArgs = OnConfig & { scopes: ScopeMask };

export type HoldArgs = OnConfig & { hold: Address };

export type ChangeArgs = OnConfig & { change: Address };

/** Deposit into or withdraw from the protected test vault. */
export type VaultTransferArgs = {
  /** The test vault's vault account. */
  vault: Address;
  amount: U64;
};

// The interface ----------------------------------------------------------------

export interface BreakglassClient {
  // Reads: chain state ---------------------------------------------------------

  /** Current cluster time (the simulated clock in mock mode). */
  getClock(): Promise<UnixSeconds>;

  /** The protocols this app knows about: their registered configs. */
  listConfigs(): Promise<AccountRecord<ProtocolConfig>[]>;

  /** A protocol's config by its protected program, or null if unregistered. */
  getConfig(
    protectedProgram: Address,
  ): Promise<AccountRecord<ProtocolConfig> | null>;

  getPauseState(config: Address): Promise<AccountRecord<PauseState> | null>;

  /** One limiter per mint. */
  listFlowLimiters(config: Address): Promise<AccountRecord<FlowLimiter>[]>;

  /** A token account's balance; the vault balance sets the effective cap. */
  getTokenBalance(tokenAccount: Address): Promise<U64>;

  /** Held withdrawals, newest first, optionally for one owner or status. */
  listHolds(
    config: Address,
    filter?: { owner?: Address; status?: HoldStatus },
  ): Promise<AccountRecord<PendingWithdrawal>[]>;

  /** Timelocked config changes, newest first (backend phase 4). */
  listPendingChanges(config: Address): Promise<AccountRecord<PendingConfig>[]>;

  /** null when the guardian has never paused: full budget, no cooldown. */
  getGuardianLedger(
    config: Address,
    guardian: Address,
  ): Promise<AccountRecord<GuardianLedger> | null>;

  /** A user's position in the test vault, or null before their first deposit. */
  getPosition(vault: Address, owner: Address): Promise<Position | null>;

  /** Breakglass events for a protocol, newest first. */
  listEvents(
    config: Address,
    options?: PageOptions,
  ): Promise<Paged<BreakglassEventRecord>>;

  // Reads: monitor ---------------------------------------------------------------

  listIncidents(status?: IncidentStatus): Promise<Incident[]>;

  getIncident(id: string): Promise<IncidentDetail | null>;

  // Writes: Breakglass -----------------------------------------------------------

  /** Register a protocol. Signed by the admin and the program's upgrade authority. */
  initializeConfig(args: InitializeConfigArgs): Promise<TxResult>;

  /** Guardian or admin pauses scopes (guardian within duration, cooldown, budget). */
  pause(args: PauseArgs): Promise<TxResult>;

  /** Extend running pauses (guardian: its own, up to the renewal cap). */
  renewPause(args: ScopesArgs): Promise<TxResult>;

  /** Lift pauses early (guardian: only its own guardian pauses). */
  unpause(args: ScopesArgs): Promise<TxResult>;

  /** Admin removes a guardian, at once. */
  removeGuardian(args: OnConfig & { guardian: Address }): Promise<TxResult>;

  /** Admin sets up the limiter for one mint. */
  initFlowLimiter(args: InitFlowLimiterArgs): Promise<TxResult>;

  /** Guardian or admin freezes a queued hold. */
  freezeHeld(args: HoldArgs): Promise<TxResult>;

  /** Admin rejects a hold; the protocol returns the amount to the position. */
  rejectHeld(args: HoldArgs): Promise<TxResult>;

  /** The hold's owner claims it through the protocol after releaseAt. */
  claimHeld(args: HoldArgs): Promise<ClaimResult>;

  /** Admin releases a frozen hold, through the timelock (backend phase 4). */
  releaseHeld(args: HoldArgs): Promise<TxResult>;

  /** Admin proposes a loosening change; it waits out the timelock. */
  proposeConfig(args: OnConfig & { action: ConfigAction }): Promise<TxResult>;

  /** Anyone executes a change once executableAt has passed. */
  executeConfig(args: ChangeArgs): Promise<TxResult>;

  /** Guardian vetoes a pending change. */
  vetoConfig(args: ChangeArgs): Promise<TxResult>;

  /** Admin cancels its own pending change. */
  cancelConfig(args: ChangeArgs): Promise<TxResult>;

  // Writes: the protected test vault ----------------------------------------------

  deposit(args: VaultTransferArgs): Promise<TxResult>;

  /**
   * Withdraw through the protocol, which asks the gate (check_outflow).
   * Allow pays out at once; Hold creates a PendingWithdrawal; a paused scope
   * rejects with ScopePaused (the Deny).
   */
  withdraw(args: VaultTransferArgs): Promise<WithdrawResult>;

  // Writes: monitor ---------------------------------------------------------------

  /** Acknowledge an incident (needs the monitor's API token). */
  ackIncident(id: string, request: AckRequest): Promise<Incident>;

  // Changes --------------------------------------------------------------------

  /**
   * Called whenever state may have changed: after each write, on each mock
   * clock tick, and on live account or monitor updates (step 6.3).
   * Returns a function that stops listening.
   */
  subscribe(onChange: () => void): () => void;
}
