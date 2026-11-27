# Progress

Claude Code updates this file at the end of every phase (see docs/BUILD_PLAN.md).

| Phase | Status | How to test | Notes |
| --- | --- | --- | --- |
| 0 Toolchain and skeleton | Done (2026-11-27) | `anchor build && anchor test` (1 passing), `cargo test -p breakglass`, `cd monitor && cargo test` (5 passing), `scripts/sync-client.sh`, `cd clients/ts && yarn build` | Toolchain pinned, lockfiles committed, program IDs synced. See below. |
| 1 Config, roles, pauses | Done (2026-11-27) | `cargo test -p breakglass` (20 passing), `anchor test` (12 passing), `yarn ts-node scripts/demo-pause.ts` | See Phase 1 notes |
| 2 Outflow gate and holds | Not started | | |
| 3 Zero-loss mode | Not started | | |
| 4 Timelocks | Not started | | |
| 5 Monitor v1 | Not started | | |
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

**Open issue for the human (not changed):** `initialize_config` lets *any* signer register *any* executable program and become its admin, so a squatter could front-run a protocol's registration. The protocol's own check (`config.protected_program == crate::ID`) doesn't catch this. Suggested fix: require the signer to be the protected program's upgrade authority (read its ProgramData account). That changes `initialize_config`'s accounts, so it needs a go-ahead.

## Decisions

(Ambiguities resolved during the build, with the reason.)

- 2026-11-27 (Phase 0): `Cargo.lock`, `yarn.lock` and `clients/ts/yarn.lock` are committed. Without a lockfile cargo resolved crates that need edition 2024 (`blake3 1.8` → `digest 0.11` → `block-buffer 0.12`), which the Solana 2.1 platform-tools (cargo 1.79) can't build.
- 2026-11-27 (Phase 0): the on-chain crates declare `rust-version = "1.79"`, so `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update` keeps to compatible versions. `blake3` is pinned to 1.5.5 in `Cargo.lock` because 1.8.x doesn't declare an MSRV. If a future `cargo update` breaks `anchor build`, re-pin it with `cargo update -p blake3 --precise 1.5.5`.
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
- 2026-11-27 (Phase 1): documented that Anchor's TS coder reports event names in camelCase (`paused`). The Rust struct names in FRONTEND.md section 6 are unchanged. The Phase 5 monitor API must pick one form for `Event.kind` and document it.
