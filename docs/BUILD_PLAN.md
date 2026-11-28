# Breakglass backend build plan

This is the build plan for the Breakglass backend. Claude Code builds it, one phase at a time. Each phase ends with something you (the human) can run and check yourself before the next phase starts.

- **Spec:** `docs/SPEC.md` is the source of truth for behavior. This plan says *in what order* to build it and *how to prove* each piece works.
- **Scope:** backend only. That means the on-chain program, the integration SDK, an example protected protocol, the off-chain monitor, alerting, and the guardian bot. No frontend in this repo, but the backend ships a frontend-ready contract: `docs/FRONTEND.md` plus the TypeScript client in `clients/ts/`.

---

## How Claude Code should work through this plan

1. Do **one phase at a time**, all on the single `backend` branch. No branch per phase. Commit each finished phase with a message starting `Phase N:` and push `backend`. `backend` reaches `main` through one PR when the human decides to ship.
2. Before writing code for a phase, re-read the matching spec sections listed in that phase.
3. Every phase has **Acceptance tests**. The phase is not done until all of them pass locally with the commands shown.
4. Write the tests first, or alongside the code. Never weaken or skip a test to make it pass.
5. At the end of each phase, update `docs/PROGRESS.md`:
   - what was built
   - the commands to test it
   - anything deferred, with a reason
6. Don't start the next phase until the human has run the **Manual check** and said go.
7. Keep defaults from the spec as named constants in `programs/breakglass/src/constants.rs`, not magic numbers.
8. No Breakglass instruction may ever hold token authority or transfer user funds. If a design seems to need it, stop and ask.
9. If something in the spec is ambiguous, pick the safer (fail-closed) reading. Note it in `docs/PROGRESS.md` under "Decisions".
10. Follow the **API contract rules** below in every phase. A phase is not done until they hold.

### API contract rules (every phase)

The frontend is built by someone else against `docs/FRONTEND.md`. It must never have to guess or read Rust.

- Every phase that adds or changes an instruction, account, event or error updates `docs/FRONTEND.md` in the same commit: args, signers, accounts, PDA seeds, field names as seen in TypeScript, and status 🔜 → ✅.
- After `anchor build`, run `scripts/sync-client.sh`. It copies `target/idl/breakglass.json` and `target/types/breakglass.ts` into `clients/ts/idl/` (committed) and runs `scripts/check-client-drift.js`.
- `clients/ts/src` stays in step with the program: seeds and PDA helpers (`pdas.ts`), the error table (`errors.ts`), constants (`constants.ts`). Add a helper for every new PDA.
- `errors.rs` is append-only, so error codes never shift.
- Event fields and account layouts are a contract. A change to either is listed under "Breaking changes" in `docs/PROGRESS.md`.
- The monitor HTTP API (Phase 5+) implements exactly the shapes in `docs/FRONTEND.md` section 7, or updates that section in the same commit.

Extra acceptance check for **every** phase:

```bash
anchor build && scripts/sync-client.sh   # must print "client in sync"
(cd clients/ts && yarn install && yarn build)
```

---

## Toolchain (pinned)

| Tool | Version | Check with |
| --- | --- | --- |
| Rust | stable (1.79+). Anchor builds programs with its own Solana toolchain. | `rustc --version` |
| Solana CLI (Agave) | 2.1.x | `solana --version` |
| Anchor CLI | 0.31.1 (via `avm`) | `anchor --version` |
| Node.js | 20 or 22 | `node --version` |
| Yarn | 1.x | `yarn --version` |
| Docker | any recent (Phase 5+, for Postgres) | `docker --version` |

Install steps are in `README.md`. If `anchor build` complains about version mismatches, fix the toolchain first. Do not change the pinned Anchor version without asking.

---

## Repository layout (target)

```
breakglass/
  Anchor.toml                 # Anchor workspace config (programs, cluster, test script)
  Cargo.toml                  # Rust workspace for on-chain crates
  package.json                # TypeScript test runner (anchor test)
  programs/
    breakglass/               # the Breakglass on-chain program
    test-vault/               # example protocol that integrates Breakglass, with a planted bug (feature flag)
  crates/
    breakglass-sdk/           # helpers protocols use to call the gate (CPI wrappers; macro later)
  tests/                      # TypeScript integration + attack tests (run by `anchor test`)
  scripts/                    # localnet/devnet helper scripts and attack simulations
  monitor/                    # off-chain monitor, separate Cargo workspace
  docs/                       # SPEC.md, BUILD_PLAN.md, PROGRESS.md
```

The monitor is a **separate Cargo workspace** on purpose. Solana client crates and Anchor program crates often need different dependency versions, and keeping them apart avoids version fights.

---

## Phase 0: Toolchain and skeleton builds

**Goal:** the starter repo builds and one test passes on your machine.

**Spec sections:** System architecture.

**Build tasks**
- Install the toolchain (README).
- `anchor keys sync` so program IDs match your local keypairs.
- Make sure `anchor build` produces `target/deploy/breakglass.so` and `target/deploy/test_vault.so`.
- `monitor/` builds with `cargo build`, and `cargo test` passes its sample unit test.

**Acceptance tests**
```bash
anchor build
anchor test                     # runs tests/breakglass.ts against a fresh local validator
cd monitor && cargo test && cd ..
```
Expected: `anchor test` prints `1 passing` (the "initializes a protocol config" test). Monitor tests pass.

**Manual check (you)**
- Run the three commands above.
- Run `solana config get` and confirm the RPC URL is `http://localhost:8899` while testing locally.

**Done when:** all green on your machine and pushed to your repo.

---

## Phase 1: Config, roles and pauses

**Goal:** a protocol can register with Breakglass, and the guardian can pause and unpause scopes within every griefing limit.

**Spec sections:**
- Roles and permissions
- On-chain program design (Accounts, Instructions)
- Open design points: pause scope, auto-expiry, renewal, early unpause, griefing limits

**Build tasks**
- Accounts:
  - `ProtocolConfig`: admin, guardians (max 5), unpausable scope mask, pause policy
  - `PauseState`
  - `GuardianLedger`
- Instructions:
  - `initialize_config`
  - `pause(scopes, duration, reason)`
  - `renew_pause(scopes)`
  - `unpause(scopes)`
  - `remove_guardian`
  - `check_scope(scope)` (read-only gate for non-outflow instructions)
- Enforce the pause rules:
  - max guardian pause 24h
  - up to 2 renewals (72h total); after that, admin only
  - 6h cooldown after a guardian pause ends
  - 96 pause-hours per 30 days per guardian
  - the guardian can lift only its own pause
  - auto-trips and admin pauses can only be lifted by the admin
  - unpausable scopes can never be paused
  - every pause has `paused_until` (expiry is checked lazily: a pause past `paused_until` counts as not paused)
- Events, all emitted via `emit_cpi!`: `Paused`, `PauseRenewed`, `Unpaused`, `GuardianRemoved`.
- Test-vault: protect `deposit` with `check_scope(DEPOSIT)`. A paused deposit must fail.

**Acceptance tests** (in `tests/breakglass.ts` and `tests/pause.ts`)
- The guardian pauses WITHDRAW. A test-vault withdraw fails with `ScopePaused`.
- The pause expires (warp the clock, or use a short test duration). The withdraw works again without any unpause call.
- The guardian tries a 25h pause → `PauseTooLong`.
- A third renewal by the guardian → `RenewCapReached`. The admin can extend past it.
- The guardian pauses again within the cooldown → `GuardianCooldown`.
- The guardian tries to unpause an admin pause → `Unauthorized`.
- Pausing an unpausable scope → `ScopeUnpausable`.
- A random keypair calling `pause` → `Unauthorized`.
- The admin removes the guardian. The old guardian's `pause` → `Unauthorized`.

```bash
anchor test
```

**Manual check (you)**
```bash
solana-test-validator --reset        # terminal 1
anchor deploy                        # terminal 2
yarn ts-node scripts/demo-pause.ts   # pauses WITHDRAW, tries a withdraw, prints the error, unpauses
```
Expected: the script prints `withdraw blocked: ScopePaused`, then `withdraw ok` after unpause.

---

## Phase 2: Outflow gate, limiter and held withdrawals

**Goal:** every withdrawal through the test-vault is allowed, held or denied by Breakglass. Large or over-cap withdrawals never move funds immediately.

**Spec sections:**
- On-chain program design: Outflow limiter, Integration in the protocol
- Step by step: A, B, C
- The gate's decision diagram

**Build tasks**
- Accounts:
  - `FlowLimiter` (per mint, 12 sub-buckets)
  - `PendingWithdrawal`
- Instructions:
  - `init_flow_limiter`
  - `check_outflow(scope, mint, amount, owner)`. The caller must be the registered protected program's PDA signer. Returns the decision `Allow | Hold | Deny` via `set_return_data`.
  - `claim_held`
  - `freeze_held` (guardian)
  - `reject_held` (admin, immediate)
  - `release_held` is a stub until Phase 4 adds the timelock
- Limiter math:
  - Roll the window forward, then compare against the cap.
  - Cap = min(absolute cap, bps × current vault balance).
  - Calls in the same transaction and the same slot all count.
  - On the first breach: return Hold, auto-trip the scope for `auto_trip_secs`, and emit `LimitTripped`.
- Threshold: amount ≥ the large-withdrawal threshold → Hold for `hold_secs` (default 6h) and emit `LargeWithdrawalQueued`.
- `crates/breakglass-sdk`: a `check_outflow` CPI helper that reads the decision from return data. The test-vault `withdraw` uses it:
  - Allow → transfer
  - Hold → create the pending record, no transfer
  - Deny → error
- Fail closed: missing, fake, or wrong-seed Breakglass accounts must make the withdraw fail. Check owner and seeds.
- Put the limiter math in a pure Rust module (`limiter.rs`) with unit tests and a property test (`proptest`). Test cases:
  - the window never under-counts
  - a cap breach always trips
  - no arithmetic overflow at `u64::MAX` amounts

**Acceptance tests**
- A small withdraw → Allow. Funds arrive and `OutflowRecorded` is emitted.
- A withdraw at or above the threshold → no funds move, a `PendingWithdrawal` exists, `claim_held` before `release_at` fails, and after warp `claim_held` succeeds.
- The guardian freezes a hold → `claim_held` fails forever, and `reject_held` returns the amount to the user's vault position.
- Many small withdraws in one transaction cross the cap → the over-cap call is Held and the scope is auto-paused.
- Withdraw with a fake `PauseState` account (right layout, wrong owner) → fails.
- Withdraw with the Breakglass accounts omitted → fails.
- `cargo test -p breakglass` runs the limiter unit and property tests green.

```bash
cargo test -p breakglass
anchor test
```

**Manual check (you)**
```bash
yarn ts-node scripts/demo-outflow.ts
```
Expected output, in order:
1. small withdraw ALLOWED
2. large withdraw HELD until <time>
3. claim too early: HoldNotReleased
4. 20 chunked withdraws: first N allowed, then HELD and `LimitTripped`

---

## Phase 3: Zero-loss mode (invariants and screen-all)

**Goal:** the planted bug in the test-vault cannot drain any funds, not even up to the cap.

**Spec sections:** Zero-loss mode (1 and 2).

**Build tasks**
- Test-vault, behind feature `planted-bug`: `withdraw` skips the user-balance check. Default builds stay safe. Test builds use the feature.
- SDK invariant hooks: `snapshot()` before the instruction body, `assert_invariants()` after. Invariants for the test-vault:
  - vault balance drop == amount owed to this user
  - total assets ≥ total liabilities
  - user can't withdraw more than their recorded position
- `FlowLimiter.instant_allowance`. When it is 0, every withdrawal becomes a `PendingWithdrawal` with `release_at = now + screen_secs` (default 120s).
- Errors: `InvariantViolated`.
- Event: `WithdrawalScreenQueued`.

**Acceptance tests**
- With `planted-bug` on and invariants on: the attacker withdraws more than their position → the transaction reverts with `InvariantViolated`, and the vault balance is unchanged.
- With invariants off and screen-all on: every attacker withdrawal is queued. The guardian freezes them all and the vault balance is unchanged.
- With both off (baseline): the attacker gets at most the window cap. This proves the backstop still works.

```bash
anchor test -- --features planted-bug   # or the script in package.json: yarn test:attack
```

**Manual check (you)**
```bash
yarn ts-node scripts/attack-big-drain.ts
```
Expected: `ATTACK FAILED: vault balance unchanged (X tokens)`.

---

## Phase 4: Timelocks and admin safety

**Goal:** a stolen admin key can't loosen anything, or release frozen funds, without a public, vetoable delay.

**Spec sections:**
- Config timelock row
- Step by step E
- Relationship to Squads

**Build tasks**
- `PendingConfig` with an action enum:
  - `RaiseLimits`
  - `AddGuardian`
  - `SetAdmin`
  - `ReleaseHeld(hold)`
  - `ChangePolicy`
- Instructions:
  - `propose_config` (admin)
  - `execute_config` (anyone, after `executable_at`)
  - `veto_config` (guardian)
  - `cancel_config` (admin)
- Timelock: 24 to 48h, default 48h, stored in config.
- Tightening actions apply instantly:
  - lower caps
  - lower thresholds
  - remove guardian
- Events: `ConfigChangeProposed`, `ConfigChangeExecuted`, `ConfigChangeVetoed`.
- Admin is a plain pubkey, so it can be a Squads vault PDA. Add a devnet script that runs `propose_config` through a Squads multisig (use `@sqds/multisig`).

**Acceptance tests**
- The admin proposes raising the cap → executing immediately fails with `TimelockActive`. After warp it succeeds.
- The guardian vetoes → executing after the delay fails with `Vetoed`.
- The admin lowers the cap → applies in the same transaction.
- A `release_held` of a frozen hold only works through the timelock.
- A random signer can't propose, and the guardian can't propose.

```bash
anchor test
```

**Manual check (you)**
```bash
yarn ts-node scripts/demo-timelock.ts
```
Expected: the script prints that the proposal was queued with its executable time, that the early execute was rejected, and that the veto worked.

---

## Phase 5: Monitor v1 (ingest, detect, alert)

**Goal:** every Breakglass event and every unexplained vault balance drop on localnet reaches you as an alert within seconds.

**Spec sections:** Monitoring and alerting backend (Ingestion, Detectors, Alert fan-out, Store).

**Build tasks** (in `monitor/`)
- Config file `monitor/config.toml`:
  - RPC URLs (2+)
  - WebSocket URLs
  - protected program ID
  - vault token accounts
  - thresholds
  - alert sinks
- Ingestors:
  - `logsSubscribe` on the Breakglass and test-vault programs
  - `accountSubscribe` on each vault token account
  - one task per RPC URL
  - dedupe by signature
  - Use `solana-client` / `solana-pubsub-client` (match the Solana version to the toolchain).
- Decode Anchor CPI events: parse the event discriminator and Borsh data. Share the event types by adding a `breakglass-events` crate, or copy the IDL types. Note the choice in PROGRESS.md.
- Detectors (each a struct implementing the `Detector` trait already in the skeleton):
  - `pause_trip`
  - `large_withdrawal`
  - `window_usage` (50% / 80%)
  - `balance_delta`
  - `config_change`
  - `program_upgrade` (watch the program's ProgramData account)
  - `liveness` (heartbeat gap > 30s)
- Alert router: severity routing, dedupe into incidents, and escalation timer (unacked Critical re-sent every 2 min).
- Sinks:
  - `stdout`
  - Telegram bot (token + chat ID from env)
  - generic signed webhook (HMAC-SHA256 header)
  - Leave a PagerDuty sink stub for later.
- Store: Postgres via `sqlx` with tables `protocols`, `events`, `incidents`, `alerts`, `acks`. `docker-compose.yml` for local Postgres. Run migrations with `sqlx migrate`.
- Admin HTTP API (axum), implementing exactly the contract in `docs/FRONTEND.md` section 7:
  - `GET /health`
  - `GET /incidents`, `GET /incidents/:id`
  - `POST /incidents/:id/ack` (bearer token)
  - `GET /holds`
  - `GET /events`
  - `GET /stream` (Server-Sent Events)
  - `[api] bind` and `cors_origins` in `monitor/config.toml`, JSON errors, cursor pagination, amounts as decimal strings
  - an API test per endpoint that checks the response matches the documented shape

**Acceptance tests**
- Unit tests for every detector, driven by fixtures (no network).
- Integration test: start `solana-test-validator`, deploy, run the monitor with the stdout sink, run `scripts/demo-outflow.ts`. The monitor must print `LargeWithdrawalQueued` (High) and `LimitTripped` (Critical) within 5 seconds of each transaction.
- Kill one RPC URL → alerts still arrive. A liveness alert fires for the dead one.

```bash
docker compose -f monitor/docker-compose.yml up -d
cd monitor && cargo test && cargo run -- --config config.toml
```

**Manual check (you)**
- Create a Telegram bot with @BotFather. Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `monitor/.env`.
- Run the monitor, then `yarn ts-node scripts/demo-outflow.ts` in another terminal.
- Expected: Telegram messages for the held withdrawal and the trip, each with the transaction signature.

---

## Phase 6: Guardian bot and screening engine

**Goal:** suspicious activity is frozen or paused automatically, without a human, within the on-chain limits.

**Spec sections:**
- Guardian bot
- Zero-loss mode (2)
- Detectors: velocity baseline, fresh-address pattern

**Build tasks**
- `monitor/src/bot.rs`: a signer that holds **only** the guardian keypair. The key is loaded from a file path in local dev. Leave a trait for a KMS signer later.
- Policy engine:
  - Critical from 2 independent detectors, or `balance_delta` alone → `pause` the related scopes.
  - Fresh-address or velocity flag on a pending withdrawal → `freeze_held`.
- Screening: for each `WithdrawalScreenQueued`, run the checks within `screen_secs`:
  - amount vs deposit history
  - destination wallet age
  - velocity
- Clean requests are left to release on their own. Flagged ones get frozen.
- Detectors:
  - `velocity_baseline`: rolling mean and standard deviation per hour, kept in Postgres
  - `fresh_address`: wallet first-seen slot via `getSignaturesForAddress`
- Rate-limit the bot's own actions. Log every action to the `actions` table.

**Acceptance tests**
- On localnet, with screen-all on: a normal user withdrawal releases after 120s. An attacker withdrawal from a wallet created 1 minute ago is frozen before release.
- Trigger `balance_delta` (transfer out of the vault via the unprotected `planted-bug` instruction) → the bot pauses WITHDRAW within 10s.
- The bot hitting the cooldown or budget gets an on-chain error. It logs it and doesn't crash-loop.

**Manual check (you)**
```bash
yarn ts-node scripts/attack-screened.ts
```
Expected: `ATTACK FAILED: N/N withdrawals frozen by guardian bot`.

---

## Phase 7: Full attack simulation suite

**Goal:** the six attack scripts from the spec's testing section all fail to steal funds. They run in CI.

**Spec sections:** Testing and attack simulation.

**Build tasks**
- The attack scripts:
  - `scripts/attacks/big-drain.ts`
  - `scripts/attacks/many-small.ts`
  - `scripts/attacks/bypass-check.ts`
  - `scripts/attacks/rogue-guardian.ts`
  - `scripts/attacks/stolen-admin.ts`
  - `scripts/attacks/monitor-outage.ts`
- Each script prints one line `PASS: <reason>` or `FAIL: <what was stolen>`, and exits non-zero on FAIL.
- `yarn test:attacks` runs them all against a fresh validator.
- GitHub Actions workflow `.github/workflows/ci.yml`:
  - install the toolchain
  - `anchor build`
  - `anchor test`
  - `yarn test:attacks`
  - `cd monitor && cargo test`
  - `scripts/sync-client.sh --check` (fails if `clients/ts/idl` is stale or the client drifted)
  - `cd clients/ts && yarn build`
- Devnet runbook in `docs/DEVNET.md`: deploy, then run the attacks against devnet with the monitor and Telegram alerts live.

**Acceptance tests**
```bash
yarn test:attacks
```
Expected: `6/6 PASS`.

**Manual check (you)**
- Push `backend` and watch CI go green.
- Follow `docs/DEVNET.md` once. You need devnet SOL from `solana airdrop 2` or a faucet.

---

## Phase 8 (optional): Upgrade timelock vault and risk co-signer

Only start this after an explicit go. Both pieces carry high risk and need separate audits.

**Spec sections:**
- Upgrade timelock vault
- Zero-loss mode (3)

**Build tasks**
- New program `programs/upgrade-vault`:
  - `queue_upgrade(buffer, code_hash)` (admin)
  - `veto_upgrade` (guardian)
  - `cancel_upgrade` (admin)
  - `execute_upgrade` (anyone, after the delay; re-hashes the buffer and CPIs the BPF upgradeable loader)
  - `return_authority` (admin, timelocked)
- Risk co-signer:
  - the test-vault instant path requires an Ed25519 instruction signed by the co-signer key, over (program, user, amount, expiry slot)
  - Breakglass verifies it through instructions sysvar introspection
  - if the signature is missing or expired → fall back to Hold

**Acceptance tests**
- Upgrade test-vault through the vault on localnet after the delay. Executing early fails. A vetoed upgrade can never run. A buffer changed after queueing fails the hash check.
- Co-signed withdraw → instant. Unsigned or expired → Held. A signature for a different amount → rejected.

---

## Definition of done (whole backend)

- All phases' acceptance tests pass in CI.
- `docs/PROGRESS.md` is up to date.
- Every Breakglass instruction has at least one negative test (wrong signer, wrong account, limit exceeded).
- A devnet run of all six attacks with live alerts is recorded in `docs/DEVNET.md`.
- Nothing in the program can transfer user funds or hold token authority. Grep for `token::transfer` and `invoke_signed` in `programs/breakglass` and justify every hit in PROGRESS.md.
