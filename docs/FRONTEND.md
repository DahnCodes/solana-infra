# Frontend integration guide

Everything a frontend needs to read Breakglass state, send Breakglass transactions and show alerts, without reading the Rust. This file is a contract: the backend updates it in the same commit as any change to the program's instructions, accounts, events or errors, or to the monitor API (see `docs/BUILD_PLAN.md`, "API contract rules"). `scripts/check-client-drift.js` fails the build if it falls behind.

**Status legend:** ✅ live on the `backend` branch · 🔜 planned, with the phase that adds it. Planned shapes come from `docs/SPEC.md`. When a phase lands, the phase updates this file to match the code exactly.

## 1. What to import

| Need | Where |
| --- | --- |
| IDL (JSON) | `clients/ts/idl/breakglass.json` (generated, committed) |
| TS type for `Program<Breakglass>` | `clients/ts/idl/breakglass.ts` (generated, committed) |
| PDAs, seeds, scope masks, error codes, event decoding | `clients/ts/src` (`@breakglass/client`) |
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
| `GuardianLedger` | `"gledger", config, guardian` | `findGuardianLedgerPda` | 🔜 P1 |
| `FlowLimiter` | `"flow", config, mint` | `findFlowLimiterPda` | 🔜 P2 |
| `PendingWithdrawal` | `"hold", config, owner, nonce(u64)` | `findPendingWithdrawalPda` | 🔜 P2 |
| `PendingConfig` | `"cfgchg", config, id(u64)` | `findPendingConfigPda` | 🔜 P4 |

Field names below are as they appear in TypeScript (Anchor camelCases them). `i64`/`u64` arrive as `BN`. Times are unix seconds. Rust enums arrive as one-key objects, for example `{ guardian: {} }`.

**`ProtocolConfig`**: `version: u8`, `bump`, `protectedProgram`, `admin` (often a Squads vault PDA), `guardians: Pubkey[]` (max 5), `unpausableMask: u64` (scopes that can never be paused), `policy: PausePolicy`, `timelockSecs: i64`, `nextChangeId: u64`.

**`PausePolicy`**: `maxGuardianPauseSecs`, `maxRenewals: u8`, `cooldownSecs`, `budgetSecsPerPeriod`, `budgetPeriodSecs`, `autoTripSecs`.

**`PauseState`**: `bump`, `config`, `active: ScopePause[]` (max 16).
**`ScopePause`**: `scope: u8`, `pausedUntil: i64`, `pausedBy`, `kind: { guardian } | { autoTrip } | { admin }`, `renewals: u8`, `reason: u16`.

> **Expiry is lazy.** An entry stays in `active` after `pausedUntil` passes, but it no longer counts. A scope is paused only if some entry has `scope === s && pausedUntil > now`. Use the cluster clock (`getBlockTime` of a recent slot) rather than the browser clock if precision matters.

**`GuardianLedger`** (🔜 P1): `guardian`, `periodStart`, `pauseSecsUsed`, `lastPauseEnd`. Remaining budget = `policy.budgetSecsPerPeriod - pauseSecsUsed`. The guardian is in cooldown until `lastPauseEnd + policy.cooldownSecs`.

**`FlowLimiter`** (🔜 P2): `mint`, `scope`, `windowSecs`, `capAbsolute: u64`, `capBpsOfVault: u16`, `buckets: u64[12]`, `bucketStart`, `largeThreshold`, `holdSecs`, `instantAllowance` (0 means screen every withdrawal), `screenSecs`. Window usage is the sum of `buckets`. The effective cap is `min(capAbsolute, capBpsOfVault × vault balance / 10000)`.

**`PendingWithdrawal`** (🔜 P2): `owner`, `mint`, `amount`, `nonce`, `createdAt`, `releaseAt`, `status: { queued } | { frozen } | { released } | { rejected } | { claimed }`. Claimable when `status` is `queued` and `now >= releaseAt`, or when `status` is `released`.

**`PendingConfig`** (🔜 P4): `id`, `actionKind: u8`, `actionData: bytes`, `proposedAt`, `executableAt`, `vetoed`, `executed`. Phase 4 replaces `actionKind`/`actionData` with a typed enum (`RaiseLimits`, `AddGuardian`, `SetAdmin`, `ReleaseHeld`, `ChangePolicy`) and documents it here.

**Listing accounts:** use `program.account.<name>.all([{ memcmp: { offset: 8 + 1, bytes: config.toBase58() } }])` for accounts whose layout starts `bump, config` (`PauseState`, `FlowLimiter`, `PendingWithdrawal`, `GuardianLedger`, `PendingConfig`). Offset 8 skips the discriminator and 1 skips `bump`. For `PendingWithdrawal` by user, add a second memcmp at offset `8 + 1 + 32` for `owner`.

## 4. Scopes

A scope is an id from 0 to 63. A set of scopes is a `u64` bitmask (`scopeMask(1, 2)` gives `0b110`). Each protocol decides what its scopes mean. The test-vault uses `DEPOSIT=0, WITHDRAW=1, BORROW=2, REPAY=3`, with REPAY unpausable. A dashboard should keep a per-protocol label map and show `unpausableMask` scopes as "always open".

## 5. Instructions

Who signs: **admin** (usually through a Squads multisig, so the frontend builds the transaction and Squads collects signatures), **guardian** (a hot key or the guardian bot), **user**, **anyone**, or **CPI** (called by the protected program inside its own instruction, never directly by a frontend).

| Instruction | Args | Signer | Accounts | Status |
| --- | --- | --- | --- | --- |
| `initialize_config` | `{ guardians: Pubkey[], unpausableMask: u64, timelockSecs: i64 \| null }` | payer + admin | `payer, admin, protectedProgram` (config, pauseState and the event accounts are resolved by Anchor) | ✅ |
| `check_scope` | `scope: u8` | CPI | `config, pauseState` | ✅ |
| `pause` | `scopes: u64, duration: i64, reason: u16` | guardian or admin | config, pauseState, guardianLedger | 🔜 P1 |
| `renew_pause` | `scopes: u64` | guardian or admin | same as `pause` | 🔜 P1 |
| `unpause` | `scopes: u64` | admin, or the guardian for its own pause | config, pauseState | 🔜 P1 |
| `remove_guardian` | `guardian: Pubkey` | admin (applies immediately) | config | 🔜 P1 |
| `init_flow_limiter` | limiter params | admin | config, flowLimiter, mint | 🔜 P2 |
| `check_outflow` | `scope, mint, amount, owner` | CPI (protected program's `"breakglass-gate"` PDA) | | 🔜 P2 |
| `claim_held` | hold | user (owner) | through the protected program | 🔜 P2 |
| `freeze_held` | hold | guardian | config, hold | 🔜 P2 |
| `reject_held` | hold | admin (immediate) | config, hold | 🔜 P2 |
| `propose_config` | action | admin | config, pendingConfig | 🔜 P4 |
| `execute_config` | | anyone, after `executableAt` | config, pendingConfig | 🔜 P4 |
| `veto_config` | | guardian | config, pendingConfig | 🔜 P4 |
| `cancel_config` | | admin | config, pendingConfig | 🔜 P4 |
| `release_held` | hold | admin, through the timelock only | | 🔜 P4 |

Planned args are indicative. The generated IDL is authoritative once the phase lands, and the phase updates this table to match it.

Example (✅ today):

```ts
await program.methods
  .initializeConfig({ guardians: [guardian], unpausableMask: new BN(1 << 3), timelockSecs: null })
  .accounts({ payer: wallet.publicKey, admin: wallet.publicKey, protectedProgram: PROTECTED_PROGRAM_ID })
  .rpc();
```

**User withdrawals go through the protected protocol, not Breakglass.** The user calls the protocol's `withdraw`. The protocol CPIs `check_outflow` and gets `Allow | Hold | Deny`. On Hold, a `PendingWithdrawal` is created and a `LargeWithdrawalQueued` or `WithdrawalScreenQueued` event says when it unlocks. The UI should show "held until `releaseAt`" and let the user claim it later through the protocol's claim instruction.

## 6. Events

Every state change emits one event, using **`emit_cpi!`**. The event is the data of a self-CPI inner instruction, **not** a `Program data:` log line, so `program.addEventListener` will **not** see it. Use the helpers in `clients/ts/src/events.ts`:

```ts
import { fetchEvents, onBreakglassEvents } from "@breakglass/client";
const events = await fetchEvents(connection, idl, program.programId, signature);
const stop = onBreakglassEvents(connection, idl, program.programId, (evs) => console.log(evs));
```

For a dashboard, prefer the monitor API (section 7). It dedupes across several RPCs and keeps history.

| Event | Fields | Meaning | Status |
| --- | --- | --- | --- |
| `ConfigInitialized` | config, protectedProgram, admin, guardians | Protocol registered | ✅ |
| `Paused` | config, scopesMask, pausedUntil, by, kind (0 guardian, 1 auto-trip, 2 admin), reason | Scopes paused | 🔜 P1 |
| `PauseRenewed` | config, scopesMask, pausedUntil, by, renewals | Pause extended | 🔜 P1 |
| `Unpaused` | config, scopesMask, by | Pause lifted early | 🔜 P1 |
| `GuardianRemoved` | config, guardian | | 🔜 P1 |
| `OutflowRecorded` | config, mint, owner, amount, windowTotal, windowCap | Withdrawal allowed | 🔜 P2 |
| `LargeWithdrawalQueued` | config, hold, mint, owner, amount, releaseAt | Held for size | 🔜 P2 |
| `WithdrawalScreenQueued` | config, hold, mint, owner, amount, releaseAt | Held for screening (zero-loss mode) | 🔜 P3 |
| `LimitTripped` | config, mint, scope, windowTotal, windowCap, pausedUntil | Cap breached, scope auto-paused | 🔜 P2 |
| `HoldFrozen` | config, hold, by | Guardian froze a hold | 🔜 P2 |
| `HoldResolved` | config, hold, outcome (0 claimed, 1 released, 2 rejected) | | 🔜 P2 |
| `ConfigChangeProposed` | config, change, actionKind, executableAt | Timelocked change queued | 🔜 P4 |
| `ConfigChangeExecuted` | config, change | | 🔜 P4 |
| `ConfigChangeVetoed` | config, change, by | | 🔜 P4 |

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
| 6017 | `InvariantViolated` | Transaction blocked by a safety check. |
| 6018 | `MathOverflow` | |
| 6019 | `NotExecutable` | |

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
