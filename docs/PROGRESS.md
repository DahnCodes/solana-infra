# Progress

Claude Code updates this file at the end of every phase (see docs/BUILD_PLAN.md).

| Phase | Status | How to test | Notes |
| --- | --- | --- | --- |
| 0 Toolchain and skeleton | Done (2026-11-27) | `anchor build && anchor test` (1 passing), `cargo test -p breakglass`, `cd monitor && cargo test` (5 passing), `scripts/sync-client.sh`, `cd clients/ts && yarn build` | Toolchain pinned, lockfiles committed, program IDs synced. See below. |
| 1 Config, roles, pauses | Done (2026-11-27) | `cargo test -p breakglass` (20 passing), `anchor test` (12 passing), `yarn ts-node scripts/demo-pause.ts` | See Phase 1 notes |
| 2 Outflow gate and holds | Done (2026-11-27) | `cargo test -p breakglass` (33 passing), `anchor test` (31 passing), `yarn ts-node scripts/demo-outflow.ts` | See Phase 2 notes |
| 3 Zero-loss mode | Done (2026-11-27) | `cargo test -p breakglass-sdk` (8 passing), `anchor test` (33 passing), `yarn test:attack` (34 passing on the planted-bug build), `yarn ts-node scripts/attack-big-drain.ts` | See Phase 3 notes |
| 4 Timelocks | Done (2026-11-27) | `cargo test -p breakglass` (43 passing), `anchor test` (48 passing incl. 7 LiteSVM clock-warp tests), `yarn ts-node scripts/demo-timelock.ts` | See Phase 4 notes |
| 5 Monitor v1 | Done (2026-11-27) | `cd monitor && cargo test` (44 passing, needs Postgres), `yarn monitor:e2e` (localnet + Postgres) | See Phase 5 notes |
| 6 Guardian bot and screening | Not started | | |
| 7 Attack suite and CI | Not started | | |
| 8 Upgrade vault and co-signer (optional) | Not started | | |

## Phase 0 notes

**Built:** nothing new in the programs. Phase 0 made the starter repo build and test cleanly on the pinned toolchain:
- Anchor CLI 0.31.1 (avm), Solana CLI 2.1.21 (platform-tools v1.43, rustc 1.79).
- `anchor keys sync`: program IDs now come from this machine's `target/deploy/*-keypair.json` (`breakglass` = `AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB`, `test_vault` = `2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn`). Updated in `lib.rs`, `Anchor.toml` (localnet + devnet), `docs/FRONTEND.md`, `monitor/config.example.toml`.
- `clients/ts/idl/` generated and committed.

**Test commands:**
```bash
anchor build && scripts/sync-client.sh       # "client in sync: 20 errors, 7 seeds, 14 events, 2 instructions"
anchor test                                  # 1 passing: initializes a protocol config
cargo test -p breakglass                     # 0 tests yet (limiter tests arrive in Phase 2)
(cd monitor && cargo test)                   # 5 passing
(cd clients/ts && yarn install && yarn build)
```

**Toolchain gotchas found:**
- If another `anchor` binary sits in `~/.cargo/bin` (e.g. from `cargo install anchor-cli`), it shadows the avm shim. Check `anchor --version` says 0.31.1. If not, put `~/.avm/bin` first on `PATH` or remove the stray binary.
- Anchor 0.31.1 switches the active Solana CLI to `[toolchain] solana_version` on every build. Without that key it picked 2.1.0, so it is now pinned to 2.1.21 in `Anchor.toml`.
- Known harmless warnings: `realloc` deprecation from Anchor 0.31.1's `#[program]` macro with solana-program 2.3, and Node 24's `MODULE_TYPELESS_PACKAGE_JSON` warning when running the tests.

**Deferred:** nothing.

## Phase 1 notes

**Built:**
- Instructions `pause`, `renew_pause`, `unpause` and `remove_guardian`. Each emits its event via `emit_cpi!` (`Paused`, `PauseRenewed`, `Unpaused`, `GuardianRemoved`).
- `GuardianLedger` is live: created with `init_if_needed` on the signer's first `pause` / `renew_pause`, and paid for by the signer.
- All pause rules are pure functions in `programs/breakglass/src/pause_logic.rs`, with 19 unit tests. The unit tests cover what the validator can't do in real time: the 96h budget, the 30-day period rollover, and the cooldown boundaries.
- Appended errors `ScopeNotPaused` (6020), `InvalidDuration` (6021) and `GuardianNotFound` (6022).
- test-vault: `deposit` is gated by `check_scope(DEPOSIT)` (already the case), and a test now proves a paused deposit fails. `withdraw` stays on `check_scope(WITHDRAW)` until Phase 2.
- TS client: new error codes, `PAUSE_KIND`, `pauseAccounts()`, and `pauses.ts` (`isScopePaused`, `pausedMask`, `scopePausedUntil`, `runningPauses`, `pauseKindName`).
- `tests/helpers.ts` holds the shared fixture: one config, 5 guardians, vault setup, and error and event assertions. Error assertions also check the code against the client's error table.
- `scripts/demo-pause.ts`: the manual check. It can be re-run, because it pauses as the admin.

**Test commands:**
```bash
cargo test -p breakglass     # 20 passing
anchor test                  # 12 passing (breakglass.ts + pause.ts), about 20s
# manual check
solana-test-validator --reset        # terminal 1
anchor deploy                        # terminal 2
yarn ts-node scripts/demo-pause.ts   # ... withdraw blocked: ScopePaused ... withdraw ok
```

**Test notes:** the pause-expiry test uses a 4s pause and waits for the cluster clock (no clock warp on `solana-test-validator`). Each test uses a different guardian, because cooldowns are real-time. Long pauses go on scope 10, which test-vault doesn't use, so they never block other tests.

**Deferred:**
- "Optional bond" for guardians (spec, griefing limits) isn't built. It needs token custody or a lamport escrow, and Breakglass must never hold funds. Revisit with the human if wanted.
- Adding a guardian and changing the pause policy are timelocked actions (Phase 4). Until then the policy is always the spec defaults.

**Open issue for the human:** `initialize_config` let any signer register any program and become its admin. Fixed in Phase 2 (go-ahead given), see below.

## Phase 2 notes

**Built:**
- **`initialize_config` fix:** the protected program's upgrade authority must sign (new accounts `upgradeAuthority`, `protectedProgramData`). Nobody else can squat a protocol's config. A program with no upgrade authority can't be registered.
- **Instructions:** `init_flow_limiter` (admin), `check_outflow` (CPI from the protocol's gate PDA, returns Allow/Hold), `claim_held` (CPI + owner), `freeze_held` (guardian or admin), `reject_held` (admin through the protocol, which restores the position).
- **Limiter math:** pure functions in `programs/breakglass/src/limiter.rs`, with 10 unit tests and 3 property tests: window never under-counts, cap breach always holds, no overflow at `u64::MAX`. Calls in the same transaction or slot all count.
- **Holds:** a PendingWithdrawal is created only on Hold, as the PDA `["hold", config, owner, hold_nonce]`, paid by the user. `kind` records why: large / limit / screen.
- **Auto-trip:** on the first breach, the gate returns Hold, pauses the limiter's scope for `auto_trip_secs` (an AutoTrip entry, admin-only to lift), and emits `LimitTripped` + `Paused` + `LimitHoldQueued`.
- **SDK** (`crates/breakglass-sdk`): `check_outflow`, `claim_held` and `reject_held` helpers. They read the decision from return data only if it came from Breakglass, and turn anything unexpected into an error.
- **test-vault:**
  - `withdraw(amount, hold_nonce)` goes through `check_outflow`. Allow → transfer. Hold → the position is reduced and nothing moves.
  - new `claim_held` and `reject_held`
  - Breakglass accounts use a `bg_` prefix, plus `gate_signer`.
- **TS client:** errors 6023–6025, `findGateSignerPda`, `findEventAuthorityPda`, `outflowAccounts()`, `randomNonce()`, and `limiter.ts` (`windowUsage`, `effectiveCap`, `effectiveThreshold`, `bucketWidth`).
- **Tests:**
  - `tests/outflow.ts`, 17 tests: every Phase 2 acceptance test, plus claim-over-cap, screen-all, wrong-seed account, wrong limiter, wrong hold PDA, another protocol's config, direct `check_outflow` call, and `init_flow_limiter` validation.
  - `tests/breakglass.ts`: 2 new tests for the `initialize_config` fix.
- **Fixture:** `tests/fixtures/fake-pause-state.json` (from `scripts/gen-fixtures.js`) is a valid unpaused PauseState owned by the Token program, preloaded by Anchor.toml.
- **Demos:** `scripts/demo-outflow.ts` (the manual check), and `scripts/demo-common.ts` shared with `demo-pause.ts` (updated for the new withdraw accounts).

**Test commands:**
```bash
cargo test -p breakglass     # 33 passing (limiter + pause rules)
anchor test                  # 31 passing, about 65s
# manual check
solana-test-validator --reset        # terminal 1
anchor deploy                        # terminal 2
yarn ts-node scripts/demo-outflow.ts
# 1. small withdraw ALLOWED (+50 tokens)
# 2. large withdraw HELD until <time> (+0 tokens, hold <address>)
# 3. claim too early: HoldNotReleased
# 4. 20 chunked withdraws: first 9 allowed, then HELD and LimitTripped; the remaining 10 blocked: ScopePaused
```
The demo leaves WITHDRAW auto-tripped (handy for UI work). The next run, and `demo-pause.ts`, lift it first.

**Toolchain/config changes:** `Anchor.toml` has `[test] upgradeable = true`, so `anchor test` loads programs with the wallet as upgrade authority, the same as `anchor deploy`. This is required by the `initialize_config` fix. It also preloads the fake PauseState fixture.

**`invoke_signed` in `programs/breakglass`:** one call, `create_hold` in `check_outflow.rs`. It's the system program's `create_account`, signed by the hold PDA's own seeds so the account can be created. No tokens are moved, and Breakglass still holds no token authority. (A grep for `token::` / `transfer` in `programs/breakglass` finds only comments.)

**Deferred:**
- `release_held` stays 🔜: Phase 4 adds it as a timelocked action. `claim_held` already accepts `Released` holds (no cap check, still recorded in the window).
- Zero-loss screening: the on-chain part landed now (see Decisions). Phase 3 adds the invariants, the planted-bug tests and the guardian-freezes-all scenario.
- The spec's "gate's decision diagram" isn't in the repo copy of SPEC.md. I followed the `check_outflow` row of the instruction table instead.

## Phase 3 notes

**Built:**
- **SDK invariants** (`crates/breakglass-sdk/src/invariants.rs`): `Snapshot { assets, liabilities, user_claim }` before the body, `assert_invariants(before, after)` after. It fails with `InvariantViolated` and logs which check broke. 8 unit tests. The checks:
  1. The vault balance moves by exactly the change in the user's claim (position plus holds). Because a claim can't go negative, this also means nobody can withdraw more than their recorded position.
  2. Total liabilities move by the same amount, so no other user's balance changed.
  3. Assets stay at or above liabilities.
- **test-vault:**
  - `withdraw` and `claim_held` snapshot and assert.
  - `Position.held` tracks held amounts, so a hold still counts as owed.
  - `initialize_vault(disable_invariants)`: only a `planted-bug` build accepts `true` (`InvariantsRequired` otherwise), and the flag is ignored in default builds.
  - The planted bug (`withdraw` skips the position check) is behind the feature, which is off by default.
- **Screen-all** (`instant_allowance` = 0 → every withdrawal becomes a hold for `screen_secs`) and `WithdrawalScreenQueued` landed early in Phase 2. Phase 3 adds the attack scenario for them.
- **Tests:** `tests/attack.ts`. In a default build it proves the bug isn't there and invariants can't be turned off. With `PLANTED_BUG=1` it runs the three acceptance scenarios. `held` bookkeeping is also asserted in `tests/outflow.ts`.
- **`yarn test:attack`** (`scripts/test-attack.sh`): builds test-vault with `--features planted-bug`, runs the whole suite against it with `PLANTED_BUG=1`, then always rebuilds the safe test-vault (even on failure).
- **`scripts/attack-big-drain.ts`**: the manual check. It works against either build, and `demo-common.ts` gained `addUser()`.
- **`Anchor.toml`** lists the test files in an explicit order (`breakglass.ts` first, since it tests registration).

**Test commands:**
```bash
cargo test -p breakglass-sdk          # 8 passing (invariants)
cargo test -p breakglass              # 33 passing
anchor test                           # 33 passing (safe build; attack.ts runs its default-build cases)
yarn test:attack                      # 34 passing on the planted-bug build, then rebuilds the safe test-vault
# manual check
solana-test-validator --reset                                         # terminal 1
anchor build -p test_vault -- --features planted-bug && anchor deploy # terminal 2
yarn ts-node scripts/attack-big-drain.ts
#   transaction reverted: InvariantViolated (BalanceNotMatchingClaim)
#   ATTACK FAILED: vault balance unchanged (10100 tokens)
anchor build -p test_vault && anchor deploy                           # put the safe build back
```
Against the safe build the same script prints `transaction reverted: InsufficientPosition` and the same `ATTACK FAILED` line.

**Results of the three scenarios (planted-bug build):**
1. **Invariants on:**
   - a 1,000 withdraw against a 100 position (Allow path) reverts
   - a 9,000 withdraw (Hold path) reverts
   - the vault, position and held amounts are unchanged
   - an honest 100 withdraw still works
2. **Invariants off, screen-all on:**
   - three 3,000 withdraws are all queued as `screen` holds
   - the guardian freezes them, and every claim after `releaseAt` fails `HoldFrozen`
   - the vault is unchanged
3. **Both off (baseline, cap 1,000, threshold 400):**
   - the attacker gets 900, more than their 100 position, which proves the bug is live
   - that is within the cap; then the scope trips and the rest are `ScopePaused`

**Deferred:**
- "The share price never falls" (spec) doesn't apply to test-vault, which has no shares. The SDK documents writing extra checks with the same pattern.
- `reject_held` and `deposit` don't run the invariants. Neither moves funds out (a reject moves held → position inside the protocol). Worth adding when protocols with fees or shares integrate.


## Phase 4 notes

**Built:**
- **`PendingConfig`** now holds a typed `ConfigAction`: `RaiseLimits { mint, params }`, `AddGuardian`, `SetAdmin`, `ReleaseHeld { hold }`, `ChangePolicy { policy, unpausable_mask, timelock_secs }`. It also records `proposed_by` and a `cancelled` flag.
- **Instructions:**
  - `propose_config` (admin; separate `payer`)
  - `execute_config` (anyone, after `executable_at`; optional `flow_limiter` / `hold` accounts)
  - `veto_config` (guardian)
  - `cancel_config` (admin)
  - `tighten_limits` (admin, immediate, only if every field is equal or stricter)
- **Release:** "release_held" is the `ReleaseHeld` action. `execute_config` marks the hold Released and emits `HoldResolved(1)`. The existing `claim_held` then pays it out without a cap check.
- **Timelock:** 24–48h, default 48h, in `config.timelock_secs` (changed only by a timelocked `ChangePolicy`).
- **Tightening applies at once:** lower caps and thresholds through `tighten_limits`; removing a guardian (`remove_guardian`, Phase 1).
- **`initialize_config`:** `admin` is a plain pubkey (no signature), so a Squads vault PDA can be named admin directly. The upgrade authority's signature authorizes the registration.
- **Rules as pure functions** in `config_logic.rs`, with 10 unit tests: what counts as tightening, applying limiter params (a window change folds the counted total into the newest bucket, so it never under-counts), policy validation, and the executable-state order closed → vetoed → timelock.
- **Events:** `ConfigChangeProposed`, `ConfigChangeExecuted`, `ConfigChangeVetoed`, plus new `ConfigChangeCancelled` and `LimitsTightened`. Errors 6026–6030 appended.
- **Tests:**
  - `tests/timelock.ts` (validator): queueing, early execute `TimelockActive`, veto, cancel, immediate tightening, `NotTightening`, frozen hold not releasable early, a stranger or guardian can't propose, bad proposals.
  - `tests/timelock-warp.ts` runs the same `.so` files in **LiteSVM** with the clock moved 48h. It covers execute after the timelock, a vetoed change still dead after the delay, cancel, frozen hold → timelocked release → claim pays out, AddGuardian, ChangePolicy (24h timelock applies to later proposals), and SetAdmin (the old admin loses power).
- **Scripts:**
  - `scripts/demo-timelock.ts` (manual check).
  - `scripts/squads-propose.ts` runs `propose_config` through a Squads v4 multisig: it creates a 1-of-1 multisig (or reuses `SQUADS_MULTISIG`), registers test-vault with the Squads vault as admin, and sends `propose_config(AddGuardian)` as a Squads vault transaction (create, approve, execute).
  - `demo-common.ts` registers a local demo guardian (`.anchor/demo-guardian-keypair.json`, gitignored).
- **Fixed:** the Phase 3 commit had dropped the `## Decisions` heading of this file (the decisions list sat under "Phase 3 notes"). It's restored.

**Test commands:**
```bash
cargo test -p breakglass                 # 43 passing
cargo test -p breakglass-sdk             # 8 passing
anchor test                              # 48 passing (validator + LiteSVM)
yarn test:attack                         # planted-bug build
# manual check
solana-test-validator --reset            # terminal 1
anchor deploy                            # terminal 2
yarn ts-node scripts/demo-timelock.ts
# 1. proposal QUEUED: raise cap 1000 -> 5000 tokens (change <pda>), executable at <time> (48h)
# 2. early execute rejected: TimelockActive
# 3. guardian VETOED it; execute now fails with: Vetoed
# 4. cap LOWERED at once: 800 tokens (no timelock for tightening)
# Squads (devnet; needs Breakglass + test-vault deployed there and a little SOL)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com yarn ts-node scripts/squads-propose.ts
```
The demo validator must be fresh (`--reset`) so test-vault is registered with the demo guardian. `squads-propose.ts` was verified on a local validator that clones the real Squads v4 program and its program config from devnet (`solana-test-validator --url devnet --clone-upgradeable-program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf --clone BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr`). It ran twice: once creating a multisig, once reusing it. It has not been run on devnet itself.

**New dev dependencies (pinned):** `litesvm@0.3.3` and `anchor-litesvm@0.2.1` (in-process runtime with a settable clock, web3.js 1.x, `@coral-xyz/anchor` ^0.31.1), and `@sqds/multisig@2.1.4`. The root `tsconfig.json` targets ES2020 so tests and scripts can use `bigint` (Squads transaction indexes). Node 20+ has it.

**Open issue for the human:** `remove_guardian` is immediate by spec. So a stolen admin key can remove every guardian *first* and then propose: nobody is left to veto, and only the timelock delay plus monitor alerts (`GuardianRemoved`, `ConfigChangeProposed`) stand in the way. Options:
- (a) make `remove_guardian` timelocked when it would leave fewer than N guardians
- (b) let guardians removed after a proposal was made still veto it
- (c) accept it and rely on Phase 5/6 alerting on `GuardianRemoved`

I'd suggest (a) with N = 1. It needs a go-ahead because the spec says removal is immediate.

**Deferred:** nothing else. Guardian *bond* (Phase 1 note) still stands.

## Phase 5 notes

**Built (`monitor/`):**
- **Ingestors** (`ingest.rs`): one task per (RPC, websocket) pair, reconnecting with backoff. Each one subscribes to:
  - logs at `processed` for the Breakglass and the protected program; each successful transaction is fetched at `confirmed`, its `emit_cpi!` inner instructions are decoded, and the PendingWithdrawal accounts its events mention are re-read
  - vault token accounts and both programs' ProgramData accounts, read once at startup as a baseline
  - slots, as a heartbeat (at most 1/s)

  Transactions are deduped by signature across RPCs. Account updates are deduped (and protected from stale RPCs) by slot.
- **Decoding** (`decode.rs`): hand-written Borsh mirrors of all 17 events and `PendingWithdrawal`. `matches_committed_idl` builds sample bytes for every event from `clients/ts/idl/breakglass.json` and checks every field decodes with the right name and value. A drift between the program and the monitor fails `cargo test`.
- **Detectors** (`detectors/`, pure, fixture-tested): `pause_trip`, `large_withdrawal` (share of vault included), `window_usage` (50% / 80%), `balance_delta`, `config_change`, `program_upgrade`, `liveness` (30s; Critical if every RPC is silent).
- **Router** (`router.rs`):
  - one incident per root cause; severity routing via `[alerts] routes`
  - unacked Critical incidents re-page every 2 min and are marked ESCALATED after 5 min
  - Critical evidence after an ack reopens the incident
  - every delivery attempt is recorded in `alerts`
  - alerts are sent in background tasks, and a database error never drops a page
- **Sinks** (`sinks/`):
  - stdout
  - Telegram (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
  - signed webhook: `X-Breakglass-Signature: sha256=HMAC-SHA256(secret, "<timestamp>.<body>")` plus `X-Breakglass-Timestamp`
  - PagerDuty: a stub that refuses to start, so nobody relies on it by accident

  A missing secret stops startup. Every alert carries the tx link, amount and share of vault where known, the scope, the gate's decision and the allowed actions.
- **Store** (`store.rs`, `migrations/0001_init.sql`): Postgres via sqlx with tables `protocols`, `events`, `incidents`, `alerts`, `acks`, plus `holds` (the PendingWithdrawal mirror). Migrations run at startup (`sqlx::migrate!`). Runtime-checked queries, so building needs no database. TLS (rustls) is enabled for managed Postgres (`?sslmode=require`).
- **API** (`api.rs`): exactly FRONTEND.md section 7, which is now ✅:
  - `GET /health`, `/incidents`, `/incidents/:id`, `/holds`, `/events`, `/stream` (SSE)
  - `POST /incidents/:id/ack` (bearer token, constant-time compare; acks disabled if `MONITOR_API_TOKEN` is unset)
  - JSON errors, cursor pagination, decimal-string amounts, CORS from `[api] cors_origins`
- **Tests** (`db_tests.rs`, `sqlx::test`, a fresh database per test): one test per API endpoint that checks the exact JSON keys and types, plus router tests for dedupe, severity rise, reopen after ack, re-page and escalation, and a failing sink being recorded without stopping the others.
- **`scripts/monitor-e2e.ts`** (`yarn monitor:e2e`): the integration acceptance test. It puts two TCP proxies in front of the validator (two "independent" RPCs), runs the monitor with the stdout sink, runs `demo-outflow.ts`, then kills one proxy.

**Test commands:**
```bash
docker compose -f monitor/docker-compose.yml up -d
(cd monitor && cargo test)        # 44 passing: 32 unit, 12 Postgres
# integration (needs: solana-test-validator --reset, anchor deploy, Postgres, (cd monitor && cargo build))
yarn monitor:e2e
```
Last run:
```
PASS: monitor started with 2 ingestors (rpc0, rpc1)
PASS: LargeWithdrawalQueued (HIGH) alerted 208ms after its block
PASS: LimitTripped (CRITICAL) alerted 354ms after its block
PASS: liveness alert for rpc1 after 10.5s
PASS: /health: degraded, rpc0 alive, rpc1 dead
PASS: alerts still arrive with rpc1 dead (693ms)
PASS: 8 incidents recorded in Postgres
```
The e2e uses `heartbeat_timeout_secs = 10` to keep the run short (the default is 30; the liveness detector is unit-tested at 30). Latency is measured from the end of the transaction's block-time second to the monitor's stdout line.

**Environment note:** on this machine the Docker daemon couldn't reach Docker Hub (IPv6 route), so the tests ran against a throwaway `postgres:17-alpine` container that was already cached. `docker-compose.yml` still pins `postgres:16`; the migrations use only SQL that both versions support.

**Deferred:**
- `velocity_baseline` and `fresh_address` detectors, the guardian bot, and `GET /pending-changes`: Phase 6, as planned.
- The spec's subscription to the admin multisig (Squads proposals touching the protocol) isn't built. Breakglass-side admin actions are covered by `config_change`. Watching Squads directly needs the multisig address in config and Squads account decoding. I'd suggest it for Phase 6 or 7.
- PagerDuty is a stub, as the plan says. Discord/Slack/SMS/email (spec) aren't built; the signed webhook can feed any of them.
- "Alerts fire at processed, state updates at confirmed": logs and accounts are subscribed at `processed`, but event details need the transaction, which RPCs only serve from `confirmed`, so event alerts fire at confirmed (about 0.4–1s later). The e2e shows under 1s end to end.
- Incidents are never auto-resolved (`resolved` is reserved). Liveness outages open a new incident each time instead.


## Decisions

(Ambiguities resolved during the build, with the reason.)

- 2026-11-27 (Phase 0): `Cargo.lock`, `yarn.lock` and `clients/ts/yarn.lock` are committed. Without a lockfile cargo resolved crates that need edition 2024 (`blake3 1.8` → `digest 0.11` → `block-buffer 0.12`), which the Solana 2.1 platform-tools (cargo 1.79) can't build.
- 2026-11-27 (Phase 0): the on-chain crates declare `rust-version = "1.79"`, so `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update` keeps to compatible versions. `blake3` is pinned to 1.5.5 in `Cargo.lock` because 1.8.x doesn't declare an MSRV. If a future `cargo update` breaks `anchor build`, re-pin it with `cargo update -p blake3 --precise 1.5.5`.
- 2026-11-27 (Phase 5): **the monitor copies the event types instead of sharing a crate.** A shared `breakglass-events` crate would pull anchor-lang 0.31 / solana-program 2.3 into the monitor's Solana 2.1 client tree, the version fight the separate workspace exists to avoid. Drift is caught instead by a test that decodes sample bytes for every event in the committed IDL.
- 2026-11-27 (Phase 5): **`Event.kind` in the API is the Rust struct name** (`LimitTripped`), matching FRONTEND.md section 6's tables. Anchor's TS coder says `limitTripped`; that difference is documented.
- 2026-11-27 (Phase 5): **alerts go out before (and regardless of) the database.** If Postgres is down, a page still goes out without an incident number. Alerting is the point; the store is history.
- 2026-11-27 (Phase 5): **each RPC fetches every transaction itself, and the pipeline keeps the first.** A "first to claim" scheme would lose events whenever the claiming RPC's fetch failed. This costs one `getTransaction` per RPC per transaction, and an ingestor skips a fetch once another has delivered it.
- 2026-11-27 (Phase 5): **`balance_delta` waits 15s (`balance_grace_secs`) before calling a drop unexplained.** The account update (processed) usually arrives before the transaction's `OutflowRecorded` (confirmed). A surplus of recorded outflows (deposit and withdrawal netting out in one update) is also forgiven after the grace, so an old credit can never hide a later theft.
- 2026-11-27 (Phase 5): **incidents reopen on new Critical evidence after an ack**, so a balance drain that continues after someone acked the first alert pages again. Lower-severity evidence attaches quietly.
- 2026-11-27 (Phase 5): **the heartbeat is the websocket slot subscription, not an HTTP poll**, so a dead websocket (no events) shows as dead even when HTTP still answers.
- 2026-11-27 (Phase 5): **acks are disabled unless `MONITOR_API_TOKEN` is set** (fail closed). The token is compared in constant time.
- 2026-11-27 (Phase 4): **"after warp" tests run in LiteSVM, not on the validator.** `solana-test-validator` can't move its clock mid-run and the minimum timelock is 24h. A test-only "short timelock" build of Breakglass would be dangerous to ship, the same reason Breakglass has no `planted-bug` feature. LiteSVM runs the exact `.so` files from `anchor build` with a settable clock. LiteSVM loads programs as non-upgradeable, so the test writes test-vault's ProgramData account directly (only `initialize_config` reads it).
- 2026-11-27 (Phase 4): **`tighten_limits` is a separate instruction** that only accepts a change where *every* field is equal or stricter. Any mixed change, even one mostly tightening, must go through the timelock. That's simpler to audit than per-field rules, and fails closed.
- 2026-11-27 (Phase 4): **what counts as stricter:** lower `cap_absolute`, `large_threshold` and `instant_allowance`; higher `window_secs`, `hold_secs`, `auto_trip_secs` and `screen_secs`; a bps limit (0 = off) may be added or lowered but never removed or raised. `scope` and `vault` never change.
- 2026-11-27 (Phase 4): **the whole pause policy, the unpausable mask and the timelock length change only through the timelock** (`ChangePolicy`), even when a field looks like tightening. For a guardian's limits, "tighter" (less pausing) is looser for the protocol, so no direction is obviously safe. A queued change keeps the `executable_at` it got when proposed.
- 2026-11-27 (Phase 4): **actions are validated at propose and again at execute.** State can change during the 48h, for example the guardian set filling up. A proposal that becomes invalid can't run, and the admin can cancel it.
- 2026-11-27 (Phase 4): **`veto_config` works until execution**, including after `executable_at` if nobody has executed yet. Only *current* guardians can veto. The admin can't veto (it cancels instead). Vetoed and cancelled changes keep their accounts for history.
- 2026-11-27 (Phase 4): **a released hold is claimable at once and not capped again.** Its release already took the timelock plus the guardian veto window. The claim is still recorded in the window. `ReleaseHeld` accepts queued or frozen holds.
- 2026-11-27 (Phase 4): **`initialize_config` no longer requires the admin's signature.** The upgrade authority already controls the program and authorizes the registration, and requiring the admin to sign forced the registration itself through Squads. A typo'd admin locks the protocol out of admin actions (recover by redeploying under a new program ID). The default pubkey is rejected.
- 2026-11-27 (Phase 4): `propose_config` has a separate `payer` signer, so a Squads vault (or any admin) can pay for its PendingConfig.
- 2026-11-27 (Phase 3): **invariants compare a per-user *claim* (position + held), not just the position.** A held withdrawal is still owed. Without counting it, the Hold path could either look like a theft or hide a bug that queues a hold bigger than the position. With it, one rule ("the vault paid exactly what the user's claim dropped by") covers both the Allow and Hold paths, and the "no withdrawal larger than the position" check follows from it.
- 2026-11-27 (Phase 3): **invariants can only be disabled in a `planted-bug` build** (the spec says "invariants are mandatory"). The baseline scenario needs them off, so the switch exists only where the bug exists, and a default build rejects it with `InvariantsRequired`.
- 2026-11-27 (Phase 3): **`yarn test:attack` replaces `anchor test -- --features planted-bug`.** That form passes the feature to every program, and the Breakglass program has no `planted-bug` feature (it must never have one). The script builds only test-vault with the bug, runs the full suite, and rebuilds the safe test-vault afterwards so a buggy `.so` is never left for `anchor deploy`.
- 2026-11-27 (Phase 3): **`InvariantViolated` is raised by the protected program** (the SDK's code is 6017), not by Breakglass. The check has to run inside the protocol's instruction after its own transfer. Frontends must check which program failed (FRONTEND.md section 8 already says so).
- 2026-11-27 (Phase 2): **Deny is an error, not a return value.** A paused scope makes `check_outflow` / `claim_held` fail inside Breakglass with `ScopePaused`, so the failing program is Breakglass and code 6000 can't be confused with the protocol's own 6000+ errors. Deny changes no state, so nothing is lost. `Decision::Deny` stays in the enum, and the SDK maps it to `ScopePaused` too.
- 2026-11-27 (Phase 2): **the protocol picks the hold nonce** (`check_outflow(..., hold_nonce)`), and the hold PDA is passed on every call but created only on Hold. The account must be in the transaction before the decision is known. A Breakglass-side counter would either write-lock the config on every withdraw or race between users. The spec's `mint` arg was dropped: the limiter account's seeds already bind the mint.
- 2026-11-27 (Phase 2): **the bucket width is `ceil(window_secs / 11)`**, so 12 buckets (11 full plus 1 partial) always cover at least `window_secs`. The window can over-count by up to one bucket (about 5.5 minutes on 1h) but never under-counts. The spec's "5 minutes each for a 1h window" would under-count by up to one bucket.
- 2026-11-27 (Phase 2): **claims count toward the window and can trip it.** Otherwise held withdrawals would get around the cap once their hold ends, and the cap guarantee would depend on someone freezing them (that is, on the monitor being up). A claim that would cross the cap auto-trips the scope and returns Hold, the hold stays `queued`, and nothing moves. Released (Phase 4, timelocked) holds aren't capped again, but they are recorded.
- 2026-11-27 (Phase 2): **decision order: paused → threshold → cap → screening.** A large withdrawal is held for size without counting or tripping. A breach trips even in screen-all mode. Held amounts don't count until claimed.
- 2026-11-27 (Phase 2): **one limiter per mint gates exactly one scope** (`limiter.scope`; `check_outflow` with another scope fails `InvalidScope`), and a breach trips that scope for **every** mint, because pauses are per scope. That's the stricter reading of "auto-pauses the scope".
- 2026-11-27 (Phase 2): **`check_outflow` write-locks `PauseState`** (it may auto-trip), so all mints of one protocol share that write lock. This trades the spec's per-mint contention goal for a global scope trip. If benchmarks show contention, a trip flag on the limiter checked by `check_scope` could replace it later.
- 2026-11-27 (Phase 2): **the large threshold also has a bps-of-balance part** (`large_threshold_bps`, new field), from the spec's "an amount plus a share of TVL (e.g. 2%)". The effective threshold is the *lower* of the two (stricter). 0 bps = absolute only. `cap_bps_of_vault` 0 likewise means no balance cap (the absolute cap must be > 0).
- 2026-11-27 (Phase 2): **`instant_allowance` screening is enforced now**, not in Phase 3. `init_flow_limiter` lets the admin set it from Phase 2, and ignoring a set value would fail open. It defaults to `u64::MAX` (no screening).
- 2026-11-27 (Phase 2): **`claim_held` requires the hold owner's signature**, on top of the protocol's gate signer. `reject_held` requires the protocol's gate signer, so a rejection always goes through the protocol and restores the user's position atomically. A direct Breakglass-only reject would strand the user's claim.
- 2026-11-27 (Phase 2): **`freeze_held` is open to the admin as well as guardians** (freezing only tightens), and only works on `queued` holds.
- 2026-11-27 (Phase 2): **`initialize_config` needs a separate `upgrade_authority` signer** rather than requiring the admin to be the upgrade authority, so the admin can still be a different multisig. The upgrade authority approves the registration.
- 2026-11-27 (Phase 1): **one pause entry per (scope, kind, paused_by)**, not one per scope. Overlapping pauses by different parties stay separate, so "the guardian can lift only its own pause" holds by construction.
- 2026-11-27 (Phase 1): **a guardian can unpause a scope only if every running pause on it is its own.** If an admin, auto-trip or other guardian pause also covers the scope, the guardian gets `Unauthorized`, even though it could in principle remove just its own entry. This keeps `Unpaused` meaning "these scopes are now open", and the guardian can only ever slow things down.
- 2026-11-27 (Phase 1): **cooldown is measured from the scheduled end** (`last_pause_end`) and also blocks new pauses while one of the guardian's own pauses is running. Lifting a pause early gives no cooldown credit and no budget refund. This is the stricter reading of "6h cooldown after a guardian pause ends". Otherwise a guardian could chain pauses across scopes and get around the renew cap. Consequence: to pause several scopes, a guardian (or the Phase 6 bot) must put them in one call, or ask the admin.
- 2026-11-27 (Phase 1): **budget is charged per call, not per scope**: `duration` for a pause and `max_guardian_pause_secs` for a renewal. "96 pause-hours" is read as wall-clock time the guardian holds the protocol paused.
- 2026-11-27 (Phase 1): **a renewal extends from the current `paused_until` by `max_guardian_pause_secs`**, so 24h + 2 × 24h = exactly the spec's 72h total. Only running pauses can be renewed. An expired one needs a new `pause` (cooldown applies).
- 2026-11-27 (Phase 1): **an admin extension is recorded as an Admin entry.** Past the guardian cap, the pause is the admin's decision, so the guardian can no longer lift it.
- 2026-11-27 (Phase 1): **admin pauses have no maximum duration** (only i64 overflow is checked), and the admin's ledger is never charged. The spec only bounds the guardian, and pausing is tightening.
- 2026-11-27 (Phase 1): **admin `unpause` is immediate, not timelocked.** The spec explicitly gives the admin "unpause anything early", and the threat model accepts that a compromised admin "can unpause during an incident". This is an explicit spec exception to "loosening goes through the timelock".
- 2026-11-27 (Phase 1): **`remove_guardian` leaves the removed guardian's running pauses in place**, because lifting them would loosen protection. The admin can `unpause` them.
- 2026-11-27 (Phase 1): if one key is both admin and guardian, it acts as admin.
- 2026-11-27 (Phase 0): `Anchor.toml` pins `solana_version = "2.1.21"` (within the 2.1.x pin) so builds are reproducible.

- 2026-11-27: one `backend` branch for all phases instead of a branch per phase. It ships to `main` through a single PR. Requested by the project owner.
- 2026-11-27: the frontend contract lives in `docs/FRONTEND.md` and `clients/ts`. Every phase keeps both in sync (see BUILD_PLAN "API contract rules").

## Breaking changes

(Any change to an event field, account layout, instruction signature, error order or monitor API response that the frontend must react to, with the date and phase.)

- 2026-11-27 (Phase 0): program IDs changed from the starter IDs to `breakglass` = `AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB`, `test_vault` = `2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn`. Read the ID from the IDL's `address` field rather than hard-coding it.
- 2026-11-27 (Phase 1): `PauseState` grows from 16 to 64 entries (`MAX_ACTIVE_PAUSES`), and a scope can now have several entries. Account size is 2925 bytes (was 765). Nothing is deployed yet, so there is no migration. Frontends must use `isScopePaused` / `pausedMask` rather than assuming one entry per scope.
- 2026-11-27 (Phase 5): the monitor API went live as specified in FRONTEND.md section 7. Details settled now: `Event.kind` is PascalCase; `Event.data` uses camelCase with u64/i64 as strings; ack errors are 401/400/404/409; lists are newest first; `/stream` messages are `{type, data}` JSON in SSE `data:` lines.
- 2026-11-27 (Phase 4): `PendingConfig` layout replaced: `action_kind: u8` + `action_data: bytes` become `action: ConfigAction`, plus `proposed_by` and `cancelled`. It was never live before, so no migration.
- 2026-11-27 (Phase 4): `initialize_config`: `admin` is no longer a signer (still passed as an account).
- 2026-11-27 (Phase 4): new events `ConfigChangeCancelled` and `LimitsTightened`. The monitor (Phase 5) must decode them. `HoldResolved.outcome = 1` (released) now occurs.
- 2026-11-27 (Phase 3): test-vault only: `initializeVault` takes `disableInvariants: bool`, `claimHeld` takes the user's `position`, `Vault` gains `invariantsOff`, and `Position` gains `held`. No Breakglass program, account, event or error changed.
- 2026-11-27 (Phase 2): `initialize_config` takes two more accounts (`upgradeAuthority` signer, `protectedProgramData`).
- 2026-11-27 (Phase 2): `FlowLimiter` gains `vault`, `large_threshold_bps` and `auto_trip_secs`. `PendingWithdrawal` gains `scope` and `kind` (appended, so the `owner` memcmp offset is unchanged). Nothing is deployed, so there is no migration.
- 2026-11-27 (Phase 2): `check_outflow`'s args are `(scope, amount, owner, hold_nonce)`, not the spec's `(scope, mint, amount, owner)`. A paused scope fails with `ScopePaused` instead of returning Deny.
- 2026-11-27 (Phase 2): test-vault `withdraw` takes `(amount, hold_nonce)` and the Breakglass accounts `bgFlowLimiter`, `bgHold`, `bgEventAuthority`, `gateSigner` (plus `systemProgram`). `bgPauseState` is now writable.
- 2026-11-27 (Phase 2): new event `LimitHoldQueued` (hold created by a cap breach). Phase 5 must decode it.
- 2026-11-27 (Phase 1): documented that Anchor's TS coder reports event names in camelCase (`paused`). The Rust struct names in FRONTEND.md section 6 are unchanged. The Phase 5 monitor API must pick one form for `Event.kind` and document it.
