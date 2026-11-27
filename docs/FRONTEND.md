# Frontend integration guide

Everything a frontend needs to read Breakglass state, send Breakglass transactions and show alerts, without reading the Rust. This file is a contract: the backend updates it in the same commit as any change to the program's instructions, accounts, events or errors, or to the monitor API (see `docs/BUILD_PLAN.md`, "API contract rules"). `scripts/check-client-drift.js` fails the build if it falls behind.

**Status legend:** ✅ live on the `backend` branch · 🔜 planned, with the phase that adds it. Planned shapes come from `docs/SPEC.md`. When a phase lands, the phase updates this file to match the code exactly.

## 1. What to import

| Need | Where |
| --- | --- |
| IDL (JSON) | `clients/ts/idl/breakglass.json` (generated, committed) |
| TS type for `Program<Breakglass>` | `clients/ts/idl/breakglass.ts` (generated, committed) |
| PDAs, seeds, scope masks, error codes, event decoding, pause-state and limiter helpers | `clients/ts/src` (`@breakglass/client`) |
| Off-chain incidents, alerts, holds | Monitor HTTP API, section 7 |

```ts
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import idl from "@breakglass/client/idl/breakglass.json";
import type { Breakglass } from "@breakglass/client/idl/breakglass";
import { protocolAddresses, scopesInMask, parseBreakglassError } from "@breakglass/client";

const program = new Program<Breakglass>(idl as Breakglass, provider); // address comes from the IDL
const { config, pauseState } = protocolAddresses(program.programId, PROTECTED_PROGRAM_ID);
const cfg = await program.account.protocolConfig.fetch(config);
const pauses = await program.account.pauseState.fetch(pauseState);
```

`clients/ts/idl/` holds the generated IDL and types (committed, refreshed by `scripts/sync-client.sh` after every program change). Until the package is published, consume it as a path or git dependency (`"@breakglass/client": "file:../solana-infra/clients/ts"`) and run `yarn build` in `clients/ts`.

Versions: `@coral-xyz/anchor` **0.31.1** (must match the program) and `@solana/web3.js` 1.x.

## 2. Program IDs

| Program | Localnet / devnet | Mainnet |
| --- | --- | --- |
| `breakglass` | `AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB` | not deployed |
| `test_vault` (example protocol, never mainnet) | `2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn` | never |

These are the IDs from the project owner's Phase 0 build. `anchor keys sync` replaces them with the deployer's own keys, so **read the ID from the IDL's `address` field** (Anchor does this for you) instead of hard-coding it. The source of truth is `Anchor.toml`.

Each protected protocol is identified by its own program ID (`protected_program`). Every per-protocol account is derived from it.

## 3. Accounts and PDAs

All accounts are owned by the Breakglass program. Seeds are UTF-8 strings. `u64` seeds are 8-byte little-endian. Every helper is in `clients/ts/src/pdas.ts`.

| Account | Seeds | Helper | Status |
| --- | --- | --- | --- |
| `ProtocolConfig` | `"config", protected_program` | `findConfigPda` | ✅ |
| `PauseState` | `"pause", config` | `findPauseStatePda` | ✅ |
| `GuardianLedger` | `"gledger", config, guardian` | `findGuardianLedgerPda` | ✅ |
| `FlowLimiter` | `"flow", config, mint` | `findFlowLimiterPda` | ✅ |
| `PendingWithdrawal` | `"hold", config, owner, nonce(u64)` | `findPendingWithdrawalPda` | ✅ |
| `PendingConfig` | `"cfgchg", config, id(u64)` | `findPendingConfigPda` | ✅ |

Two PDAs that aren't Breakglass accounts also appear in transactions: the protected program's **gate signer** `["breakglass-gate"]` under the *protected* program (`findGateSignerPda`), and Breakglass's **event authority** `["__event_authority"]` (`findEventAuthorityPda`). `outflowAccounts()` derives all of them for one withdraw.

Field names below are as they appear in TypeScript (Anchor camelCases them). `i64`/`u64` arrive as `BN`. Times are unix seconds. Rust enums arrive as one-key objects, for example `{ guardian: {} }`.

**`ProtocolConfig`**: `version: u8`, `bump`, `protectedProgram`, `admin` (often a Squads vault PDA), `guardians: Pubkey[]` (max 5), `unpausableMask: u64` (scopes that can never be paused), `policy: PausePolicy`, `timelockSecs: i64`, `nextChangeId: u64`.

**`PausePolicy`**: `maxGuardianPauseSecs`, `maxRenewals: u8`, `cooldownSecs`, `budgetSecsPerPeriod`, `budgetPeriodSecs`, `autoTripSecs`.

**`PauseState`**: `bump`, `config`, `active: ScopePause[]` (max 64).
**`ScopePause`**: `scope: u8`, `pausedUntil: i64`, `pausedBy`, `kind: { guardian } | { autoTrip } | { admin }`, `renewals: u8`, `reason: u16`.

There is one entry per (scope, kind, `pausedBy`), so **one scope can have several entries**, for example a guardian's pause and an admin's pause on WITHDRAW at the same time. The scope reopens when the last of them ends.

> **Expiry is lazy.** An entry stays in `active` after `pausedUntil` passes, but it no longer counts. Expired entries are removed on the next pause, renew or unpause. A scope is paused only if some entry has `scope === s && pausedUntil > now`. Use `isScopePaused`, `pausedMask`, `scopePausedUntil` and `runningPauses` from `clients/ts/src/pauses.ts` instead of reading `active` directly. Use the cluster clock (`getBlockTime` of a recent slot) rather than the browser clock if precision matters.

**`GuardianLedger`**: `bump`, `config`, `guardian`, `periodStart`, `pauseSecsUsed`, `lastPauseEnd`. One per signer of `pause` / `renew_pause`, created (and paid for) by the signer on first use. It doesn't exist until then, so treat a missing ledger as "full budget, no cooldown". The admin gets one too, but it is never charged.
- **Budget:** remaining = `policy.budgetSecsPerPeriod - pauseSecsUsed`. When `now >= periodStart + policy.budgetPeriodSecs`, the next pause starts a fresh period (so show the full budget then).
- **Cooldown:** the guardian can't start a new pause until `lastPauseEnd + policy.cooldownSecs`. `lastPauseEnd` is the *scheduled* end of its latest pause. Lifting a pause early doesn't move it, and it is in the future while one of its pauses runs.

**`FlowLimiter`**: `bump`, `config`, `mint`, `vault` (the protocol's vault token account for `mint`), `scope` (the outflow scope it gates and auto-trips), `windowSecs`, `capAbsolute: u64`, `capBpsOfVault: u16` (0 = no balance-based cap), `buckets: u64[12]`, `bucketStart`, `largeThreshold: u64`, `largeThresholdBps: u16` (0 = absolute threshold only), `holdSecs`, `autoTripSecs`, `instantAllowance: u64` (0 = screen every withdrawal; u64 max = never screen), `screenSecs`.
- **Window usage**: use `windowUsage(limiter, now)` from `clients/ts/src/limiter.ts`. Each bucket is `ceil(windowSecs / 11)` seconds wide (so the window never under-counts) and `bucketStart` is the start of the newest. The raw sum of `buckets` can include expired buckets until the next write; the helper skips them like the program does. `effectiveCap(limiter, vaultBalance)` and `effectiveThreshold(...)` are there too.
- **Effective cap** = `min(capAbsolute, capBpsOfVault × vaultBalance / 10000)` (just `capAbsolute` when bps is 0). It shrinks as the vault drains.
- **Effective threshold** = `min(largeThreshold, largeThresholdBps × vaultBalance / 10000)` (just `largeThreshold` when bps is 0).

**`PendingWithdrawal`**: `bump`, `config`, `owner`, `mint`, `amount`, `nonce`, `createdAt`, `releaseAt`, `status: { queued } | { frozen } | { released } | { rejected } | { claimed }`, `scope`, `kind: { large } | { limit } | { screen }` (why it was held: size, a cap breach, or zero-loss screening). Claimable when the scope isn't paused and either `status` is `queued` with `now >= releaseAt`, or `status` is `released` (Phase 4). Accounts stay after they resolve, so history remains readable.

**`PendingConfig`**: `bump`, `config`, `id`, `action: ConfigAction`, `proposedBy`, `proposedAt`, `executableAt`, `vetoed`, `executed`, `cancelled`. Ids count up from 0 per protocol (`config.nextChangeId` is the next one).
- **State:** `cancelled` → cancelled. Else `executed` → done. Else `vetoed` → dead (can never run). Else `now < executableAt` → waiting (guardians can veto). Else ready: anyone can call `execute_config`.
- **`ConfigAction`** (one-key object, like every Anchor enum):
  - `{ raiseLimits: { mint, params: LimiterParams } }`: replace the limiter settings for `mint`, loosening allowed.
  - `{ addGuardian: { guardian } }`
  - `{ setAdmin: { admin } }`
  - `{ releaseHeld: { hold } }`: a queued or frozen hold becomes `released`. It is claimable at once and not capped again.
  - `{ changePolicy: { policy: PausePolicy, unpausableMask, timelockSecs } }`: `timelockSecs` must be 24h–48h, and a change already queued keeps its `executableAt`.
- **`LimiterParams`**: `windowSecs`, `capAbsolute`, `capBpsOfVault`, `largeThreshold`, `largeThresholdBps`, `holdSecs`, `autoTripSecs`, `instantAllowance`, `screenSecs`. These are the FlowLimiter's settings without `scope` and `vault`, which never change. Start from the current limiter and change what you need.

**Listing accounts:** use `program.account.<name>.all([{ memcmp: { offset: 8 + 1, bytes: config.toBase58() } }])` for accounts whose layout starts `bump, config` (`PauseState`, `FlowLimiter`, `PendingWithdrawal`, `GuardianLedger`, `PendingConfig`). Offset 8 skips the discriminator and 1 skips `bump`. For `PendingWithdrawal` by user, add a second memcmp at offset `8 + 1 + 32` for `owner`.

## 4. Scopes

A scope is an id from 0 to 63. A set of scopes is a `u64` bitmask (`scopeMask(1, 2)` gives `0b110`). Each protocol decides what its scopes mean. The test-vault uses `DEPOSIT=0, WITHDRAW=1, BORROW=2, REPAY=3`, with REPAY unpausable. A dashboard should keep a per-protocol label map and show `unpausableMask` scopes as "always open".

## 5. Instructions

Who signs: **admin** (usually through a Squads multisig, so the frontend builds the transaction and Squads collects signatures), **guardian** (a hot key or the guardian bot), **user**, **anyone**, or **CPI** (called by the protected program inside its own instruction, never directly by a frontend).

| Instruction | Args | Signer | Accounts | Status |
| --- | --- | --- | --- | --- |
| `initialize_config` | `{ guardians: Pubkey[], unpausableMask: u64, timelockSecs: i64 \| null }` | payer + the protected program's **upgrade authority**. `admin` is just a pubkey (no signature), so it can be a Squads vault. | `payer, admin, upgradeAuthority, protectedProgram, protectedProgramData` (ProgramData = PDA `[protectedProgram]` of `BPFLoaderUpgradeab1e11111111111111111111111`). Fails with `Unauthorized` if `upgradeAuthority` isn't the program's upgrade authority (so a program with no upgrade authority can't be registered), or if `admin` is the default pubkey. | ✅ |
| `check_scope` | `scope: u8` | CPI | `config, pauseState` | ✅ |
| `pause` | `scopes: u64` (mask), `duration: i64` (seconds), `reason: u16` (free-form code) | guardian or admin (`authority`, also pays for its ledger on first use) | `authority, config, pauseState, guardianLedger` (ledger = `findGuardianLedgerPda(config, authority)`; `pauseAccounts()` builds all four) | ✅ |
| `renew_pause` | `scopes: u64` | guardian or admin (`authority`) | same as `pause` | ✅ |
| `unpause` | `scopes: u64` | admin, or a guardian for its own pause (`authority`) | `authority, config, pauseState` | ✅ |
| `remove_guardian` | `guardian: Pubkey` | admin (applies immediately) | `admin, config` | ✅ |
| `init_flow_limiter` | `{ scope: u8, windowSecs: i64 \| null, capAbsolute: u64, capBpsOfVault: u16, largeThreshold: u64, largeThresholdBps: u16, holdSecs: i64 \| null, autoTripSecs: i64 \| null, instantAllowance: u64 \| null, screenSecs: i64 \| null }` (null = default: 1h window, 6h hold, policy auto-trip 1h, no screening, 120s screen) | admin (pays rent) | `admin, config, mint, vault, flowLimiter`. One per mint, can't be re-initialized. `InvalidLimiterConfig` if window < 12s, cap 0, a bps value > 10000, or a duration ≤ 0. `ScopeUnpausable` for an unpausable scope. | ✅ |
| `check_outflow` | `scope: u8, amount: u64, owner: Pubkey, holdNonce: u64` | CPI only: the protected program's gate signer, plus a `payer` | `gateSigner, payer, config, pauseState, flowLimiter, vault, hold, systemProgram` + event accounts. Returns `Allow` or `Hold` (return data). A paused scope fails with `ScopePaused`, which is the Deny. Calling it directly fails with `InvalidCaller`. | ✅ |
| `claim_held` | none | CPI only (gate signer) + the hold's `owner` | `gateSigner, owner, config, pauseState, flowLimiter, vault, hold` + event accounts. Returns `Allow` (protocol pays out) or `Hold` (claim would cross the cap: scope auto-tripped, hold stays `queued`). Errors: `HoldNotReleased`, `HoldFrozen`, `HoldInvalidState`, `ScopePaused`. | ✅ |
| `freeze_held` | none | guardian or admin (`authority`) | `authority, config, hold`. Only `queued` holds (`HoldInvalidState` otherwise). Frozen holds can never be claimed. | ✅ |
| `reject_held` | none | admin + CPI (gate signer), i.e. through the protected program | `admin, gateSigner, config, hold` + event accounts. `queued`, `frozen` or `released` → `rejected`. The protocol returns the amount to the user's position in the same transaction. | ✅ |
| `propose_config` | `action: ConfigAction` | admin + `payer` (pays rent; for Squads, both are the vault) | `payer, admin, config, pending` (`pending` = `findPendingConfigPda(config, config.nextChangeId)`) + event accounts. `executableAt = now + config.timelockSecs`. The action is validated now and again at execution: `DuplicateGuardian`, `TooManyGuardians`, `InvalidLimiterConfig`, `InvalidPolicy`, `InvalidTimelock`. | ✅ |
| `execute_config` | none | anyone | `config, pending, flowLimiter, hold` + event accounts. `flowLimiter` (the mint's limiter) is required for `raiseLimits`, `hold` for `releaseHeld`. Pass `null` otherwise. Errors: `TimelockActive`, `Vetoed`, `ChangeClosed`, `WrongChangeAccounts`. | ✅ |
| `veto_config` | none | a current guardian | `guardian, config, pending` + event accounts. Works any time until execution, even after `executableAt`. | ✅ |
| `cancel_config` | none | admin | `admin, config, pending` + event accounts. Also allowed after a veto. | ✅ |
| `tighten_limits` | `params: LimiterParams` | admin | `admin, config, flowLimiter` + event accounts. Applies **immediately** if every field is equal or stricter: lower caps, thresholds and instant allowance; longer window, holds, auto-trip and screening; a bps limit can be added or lowered, not removed. Otherwise `NotTightening`, so propose it instead. | ✅ |
| release a hold | | admin, timelocked | There is no `release_held` instruction: use `propose_config({ releaseHeld: { hold } })`, then `execute_config` with `hold`. | ✅ |

Planned args are indicative. The generated IDL is authoritative once the phase lands, and the phase updates this table to match it. `config` must always be passed explicitly: its seeds use its own `protectedProgram` field, so Anchor can't resolve it.

Examples (✅ today):

```ts
await program.methods
  .initializeConfig({ guardians: [guardian], unpausableMask: new BN(1 << 3), timelockSecs: null })
  .accountsPartial({
    payer: wallet.publicKey,
    admin: wallet.publicKey,
    upgradeAuthority: wallet.publicKey, // must be PROTECTED_PROGRAM_ID's upgrade authority
    protectedProgram: PROTECTED_PROGRAM_ID,
    protectedProgramData: PublicKey.findProgramAddressSync(
      [PROTECTED_PROGRAM_ID.toBuffer()],
      new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    )[0],
  })
  .rpc();

// Guardian freezes a held withdrawal.
await program.methods.freezeHeld().accountsPartial({ authority: guardian.publicKey, config, hold }).signers([guardian]).rpc();

// Guardian pauses WITHDRAW (scope 1) for 2 hours with reason code 42.
const accts = pauseAccounts(program.programId, PROTECTED_PROGRAM_ID, guardian.publicKey);
await program.methods.pause(new BN(scopeMask(1).toString()), new BN(2 * 3600), 42)
  .accountsPartial(accts).signers([guardian]).rpc();
await program.methods.renewPause(new BN(scopeMask(1).toString())).accountsPartial(accts).signers([guardian]).rpc();
await program.methods.unpause(new BN(scopeMask(1).toString()))
  .accountsPartial({ authority: guardian.publicKey, config: accts.config, pauseState: accts.pauseState })
  .signers([guardian]).rpc();
```

### Pause rules

What the program enforces, so a UI can disable buttons and explain errors before sending:

| Rule | Guardian | Admin |
| --- | --- | --- |
| Who | Must be in `config.guardians` at call time. A removed guardian loses every power at once. | `config.admin`. If a key is both, it acts as admin. |
| Scopes | Mask must be non-zero (`InvalidScope`) and must not touch `unpausableMask` (`ScopeUnpausable`). | Same. |
| `pause` duration | `1 ..= policy.maxGuardianPauseSecs` (24h), else `InvalidDuration` / `PauseTooLong`. | Any positive duration. |
| `pause` cooldown | No new pause while one of its own pauses is running, or until `lastPauseEnd + cooldownSecs` (6h) (`GuardianCooldown`). To pause more scopes at once, put them all in one mask. | None. |
| Budget | Each `pause` charges `duration` and each `renew_pause` charges `maxGuardianPauseSecs`, once per call (not per scope), against `budgetSecsPerPeriod` (96h per 30 days) (`PauseBudgetExhausted`). | None. |
| `renew_pause` | Only its own running pauses, each extended by `maxGuardianPauseSecs` from its current `pausedUntil`, at most `maxRenewals` (2) times (`RenewCapReached`). 24h + 2 × 24h = 72h max. A scope paused only by someone else gives `Unauthorized`. A scope with no running pause gives `ScopeNotPaused`. | Any running pause, no cap. Adds an **admin** entry ending `maxGuardianPauseSecs` after the scope's latest end, so from then on only the admin can lift it. |
| `unpause` | Only if **every** running pause on each requested scope is its own guardian pause. Otherwise `Unauthorized` (so it can't lift auto-trips, admin pauses or another guardian's pause). | Lifts every running pause on the scopes. |
| Not paused | Scopes in the mask that aren't paused are skipped. If nothing was lifted: `ScopeNotPaused`. | Same. |
| Re-pausing | Can't (cooldown). | Pausing an already admin-paused scope never shortens it (`pausedUntil` = the later of the two). |

**User withdrawals go through the protected protocol, not Breakglass.** The user calls the protocol's `withdraw`. The protocol CPIs `check_outflow`:
- **Allow:** the funds arrive in the same transaction (`OutflowRecorded`).
- **Hold:** no funds move. A `PendingWithdrawal` is created at `["hold", config, user, holdNonce]` (rent paid by the user) and an event says why and until when: `LargeWithdrawalQueued` (size), `LimitHoldQueued` (cap breach, with `LimitTripped` + `Paused`) or `WithdrawalScreenQueued` (screening). The transaction **succeeds**, so read the events or the hold account to tell Hold from Allow. Show "held until `releaseAt`", then let the user claim through the protocol's claim instruction.
- **Paused (Deny):** the transaction fails with Breakglass `ScopePaused` (6000).

**Picking `holdNonce`:** the hold account must be in the transaction before the decision is known, so the client picks the nonce (any unused u64; `outflowAccounts()` uses a random one) and passes both the nonce and the hold PDA. An already-used nonce makes a held withdrawal fail.

**test-vault's instructions** (the reference integration, `clients/ts/idl` has no test-vault types; read `target/idl/test_vault.json`): `initializeVault(disableInvariants: bool)` (must be `false` outside attack-test builds), `withdraw(amount, holdNonce)`, `claimHeld()` (also takes the user's `position`), `rejectHeld()` (admin). Breakglass accounts use a `bg` prefix (`bgConfig, bgPauseState, bgFlowLimiter, bgHold, bgEventAuthority`) plus `gateSigner`. A test-vault `Position` is `{ owner, vault, amount, held }`: `amount` is withdrawable now, `held` sits in queued or frozen holds and is still owed to the user.

**Every claim counts against the window.** If a claim would cross the cap, it auto-trips the scope and pays nothing (the hold stays `queued`); try again after the window frees up and the admin reopens the scope.

### Zero-loss mode

Two protections a UI should explain:
- **Screen-all** (`FlowLimiter.instantAllowance` = 0, or small): every withdrawal above the allowance is held for `screenSecs` (default 120s) as `kind: screen`, emitting `WithdrawalScreenQueued`. Clean ones are claimable after `releaseAt`. Flagged ones are frozen by the guardian (bot from Phase 6). Show "screening, ready at `releaseAt`" rather than "held".
- **Invariants:** the protocol checks its own books inside the withdraw/claim transaction (`breakglass_sdk::invariants`). If anything doesn't add up, the transaction reverts with `InvariantViolated` (6017), raised by **the protocol's program**, not Breakglass, so the failing program ID is the protocol's. An honest user never sees it. If they do, the protocol has a bug, so show "blocked by a safety check" and don't suggest retrying.

## 6. Events

Every state change emits one event, using **`emit_cpi!`**. The event is the data of a self-CPI inner instruction, **not** a `Program data:` log line, so `program.addEventListener` will **not** see it. Use the helpers in `clients/ts/src/events.ts`:

```ts
import { fetchEvents, onBreakglassEvents } from "@breakglass/client";
const events = await fetchEvents(connection, idl, program.programId, signature);
const stop = onBreakglassEvents(connection, idl, program.programId, (evs) => console.log(evs));
```

Anchor's TS coder reports event names in **camelCase** (`paused`, `pauseRenewed`), not as the Rust struct names in the table below (`Paused`, `PauseRenewed`). Field names are camelCase too.

For a dashboard, prefer the monitor API (section 7). It dedupes across several RPCs and keeps history.

| Event | Fields | Meaning | Status |
| --- | --- | --- | --- |
| `ConfigInitialized` | config, protectedProgram, admin, guardians | Protocol registered | ✅ |
| `Paused` | config, scopesMask, pausedUntil, by, kind (0 guardian, 1 auto-trip, 2 admin), reason | Scopes paused. `pausedUntil` is the latest end across the scopes (an admin re-pause never shortens). | ✅ |
| `PauseRenewed` | config, scopesMask, pausedUntil, by, renewals | Pause extended. `pausedUntil` and `renewals` are the max across the scopes. `by` is the admin when the admin extended past the cap. | ✅ |
| `Unpaused` | config, scopesMask, by | Pause lifted early. `scopesMask` holds only the scopes actually lifted, and each of them is now open. Expiry emits nothing. | ✅ |
| `GuardianRemoved` | config, guardian | Guardian removed by the admin. Its running pauses stay until they expire or the admin lifts them. | ✅ |
| `OutflowRecorded` | config, mint, owner, amount, windowTotal, windowCap | Funds left the vault: an allowed withdrawal or a claimed hold. `windowTotal` includes `amount`. | ✅ |
| `LargeWithdrawalQueued` | config, hold, mint, owner, amount, releaseAt | Held for size (`kind: large`) | ✅ |
| `LimitHoldQueued` | config, hold, mint, owner, amount, releaseAt | Held because it would cross the cap (`kind: limit`). Emitted after `LimitTripped` and `Paused`. | ✅ |
| `WithdrawalScreenQueued` | config, hold, mint, owner, amount, releaseAt | Held for screening (`kind: screen`, zero-loss mode: amount over `instantAllowance`) | ✅ |
| `LimitTripped` | config, mint, scope, windowTotal, windowCap, pausedUntil | Cap breached, scope auto-paused until `pausedUntil` (admin-only unpause). `windowTotal` excludes the held amount. Always followed by `Paused` with `kind` 1, `by` = the limiter, `reason` 1. | ✅ |
| `HoldFrozen` | config, hold, by | A guardian (or the admin) froze a hold | ✅ |
| `HoldResolved` | config, hold, outcome (0 claimed, 1 released, 2 rejected) | 1 comes from `execute_config(releaseHeld)` (the hold is then claimable). A claim emits it before its `OutflowRecorded`. | ✅ |
| `ConfigChangeProposed` | config, change, actionKind (0 raiseLimits, 1 addGuardian, 2 setAdmin, 3 releaseHeld, 4 changePolicy; `ACTION_KIND`), executableAt | Timelocked change queued. Fetch `change` for the full action. | ✅ |
| `ConfigChangeExecuted` | config, change | Applied | ✅ |
| `ConfigChangeVetoed` | config, change, by | A guardian killed it | ✅ |
| `ConfigChangeCancelled` | config, change | The admin withdrew it | ✅ |
| `LimitsTightened` | config, flowLimiter, mint | The admin tightened a limiter at once (no timelock) | ✅ |

## 7. Monitor HTTP API (🔜 Phase 5, extended in Phase 6)

An off-chain service in `monitor/`. JSON over HTTP, served by axum. This is the contract Phase 5 must implement. Any change updates this section in the same commit.

- Base URL: `http://127.0.0.1:8080` by default (`[api] bind` in `monitor/config.toml`).
- CORS: allowed origins come from `[api] cors_origins` (empty by default, which means same-origin only).
- Auth: read endpoints are open on localhost. Write endpoints (`ack`) require `Authorization: Bearer <MONITOR_API_TOKEN>` from `monitor/.env`.
- Times are RFC 3339 strings. Amounts are decimal **strings** (u64 does not fit in a JS number). Pubkeys and signatures are base58.
- Errors: `{ "error": { "code": "not_found", "message": "..." } }` with a matching HTTP status.
- Lists: `?limit=` (default 50, max 500) and `?cursor=`. Responses are `{ "items": [...], "next_cursor": string | null }`.

| Method and path | Returns |
| --- | --- |
| `GET /health` | `{ "status": "ok" \| "degraded", "rpc": [{ "url", "last_slot", "lag_secs", "alive" }] }` |
| `GET /incidents?status=open\|acked\|resolved` | list of `Incident` |
| `GET /incidents/:id` | `Incident` with `events: Event[]` and `alerts: Alert[]` |
| `POST /incidents/:id/ack` | body `{ "by": string, "note"?: string }`, returns `Incident` |
| `GET /holds?owner=&status=` | list of `Hold`, mirrored from `PendingWithdrawal` |
| `GET /events?kind=&since=` | list of `Event` |
| `GET /pending-changes` (Phase 6) | list of mirrored `PendingConfig` |

```ts
type Severity = "info" | "warning" | "high" | "critical";
interface Incident { id: string; protocol: string; detector: string; severity: Severity;
  title: string; status: "open" | "acked" | "resolved"; opened_at: string;
  acked_by: string | null; acked_at: string | null; signatures: string[] }
interface Event { id: string; kind: string /* event name from section 6 */; signature: string;
  slot: number; block_time: string; data: Record<string, unknown> /* event fields, camelCase */ }
interface Hold { address: string; owner: string; mint: string; amount: string; nonce: string;
  created_at: string; release_at: string; status: "queued" | "frozen" | "released" | "rejected" | "claimed" }
interface Alert { id: string; sink: string; sent_at: string; ok: boolean }
```

Live updates: Phase 5 adds `GET /stream`, a Server-Sent Events feed of `{ "type": "event" | "incident", "data": ... }`. Until then, poll `GET /incidents`.

The API never signs anything. For admin actions it may later return unsigned or Squads-proposal transactions for the frontend to hand to a wallet.

## 8. Errors

Anchor numbers custom errors from 6000 in declaration order. `errors.rs` is append-only, so these codes are stable. `parseBreakglassError(err)` maps a thrown error to `{ code, name, msg }`.

| Code | Name | Typical UI message |
| --- | --- | --- |
| 6000 | `ScopePaused` | This action is temporarily paused for safety. |
| 6001 | `InvalidScope` | |
| 6002 | `ScopeUnpausable` | This action can't be paused. |
| 6003 | `Unauthorized` | Your wallet isn't allowed to do this. |
| 6004 | `TooManyGuardians` | |
| 6005 | `PauseTooLong` | Pause is longer than the guardian maximum. |
| 6006 | `RenewCapReached` | Renewal limit reached. Only the admin can extend. |
| 6007 | `GuardianCooldown` | Guardian is cooling down. |
| 6008 | `PauseBudgetExhausted` | Guardian has used its pause budget for this period. |
| 6009 | `TooManyActivePauses` | |
| 6010 | `HoldNotReleased` | Not unlocked yet. Show `releaseAt`. |
| 6011 | `HoldFrozen` | Under review by the guardian. |
| 6012 | `HoldInvalidState` | |
| 6013 | `InvalidCaller` | |
| 6014 | `TimelockActive` | Change is queued. Show `executableAt`. |
| 6015 | `InvalidTimelock` | |
| 6016 | `Vetoed` | Change was vetoed by the guardian. |
| 6017 | `InvariantViolated` | Transaction blocked by a safety check. Raised by the *protected* program through the SDK (zero-loss invariants), so the failing program is the protocol's. |
| 6018 | `MathOverflow` | |
| 6019 | `NotExecutable` | |
| 6020 | `ScopeNotPaused` | Nothing to renew or lift: that scope isn't paused. |
| 6021 | `InvalidDuration` | Pause duration must be more than zero. |
| 6022 | `GuardianNotFound` | That key isn't a guardian. |
| 6023 | `InvalidLimiterConfig` | Limiter settings out of range. |
| 6024 | `WrongVault` | Wrong vault account for this limiter. |
| 6025 | `WrongHold` | Wrong held-withdrawal account (seeds, owner, mint or limiter). |
| 6026 | `NotTightening` | This loosens a limit: propose it through the timelock. |
| 6027 | `DuplicateGuardian` | Already a guardian. |
| 6028 | `ChangeClosed` | That change was already executed or cancelled. |
| 6029 | `WrongChangeAccounts` | Wrong or missing limiter/hold for this change. |
| 6030 | `InvalidPolicy` | Pause policy values out of range. |

A protected protocol has its own errors that also start at 6000, so check which program failed before mapping a code.

## 9. Local setup for frontend work

```bash
solana-test-validator --reset                   # terminal 1
anchor build && anchor deploy                   # terminal 2
scripts/sync-client.sh                          # refresh clients/ts/idl
cd clients/ts && yarn install && yarn build
# RPC http://127.0.0.1:8899, WS ws://127.0.0.1:8900
```

Demo scripts added by each phase (`scripts/demo-*.ts`) put the validator into interesting states (paused scopes, held withdrawals, tripped limits) for UI work.
