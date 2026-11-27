# Progress

Claude Code updates this file at the end of every phase (see docs/BUILD_PLAN.md).

| Phase | Status | How to test | Notes |
| --- | --- | --- | --- |
| 0 Toolchain and skeleton | Done (2026-11-27) | `anchor build && anchor test` (1 passing), `cargo test -p breakglass`, `cd monitor && cargo test` (5 passing), `scripts/sync-client.sh`, `cd clients/ts && yarn build` | Toolchain pinned, lockfiles committed, program IDs synced. See below. |
| 1 Config, roles, pauses | Not started | | |
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

## Decisions

(Ambiguities resolved during the build, with the reason.)

- 2026-11-27 (Phase 0): `Cargo.lock`, `yarn.lock` and `clients/ts/yarn.lock` are committed. Without a lockfile cargo resolved crates that need edition 2024 (`blake3 1.8` → `digest 0.11` → `block-buffer 0.12`), which the Solana 2.1 platform-tools (cargo 1.79) can't build.
- 2026-11-27 (Phase 0): the on-chain crates declare `rust-version = "1.79"`, so `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update` keeps to compatible versions. `blake3` is pinned to 1.5.5 in `Cargo.lock` because 1.8.x doesn't declare an MSRV. If a future `cargo update` breaks `anchor build`, re-pin it with `cargo update -p blake3 --precise 1.5.5`.
- 2026-11-27 (Phase 0): `Anchor.toml` pins `solana_version = "2.1.21"` (within the 2.1.x pin) so builds are reproducible.

- 2026-11-27: one `backend` branch for all phases instead of a branch per phase. It ships to `main` through a single PR. Requested by the project owner.
- 2026-11-27: the frontend contract lives in `docs/FRONTEND.md` and `clients/ts`. Every phase keeps both in sync (see BUILD_PLAN "API contract rules").

## Breaking changes

(Any change to an event field, account layout, instruction signature, error order or monitor API response that the frontend must react to, with the date and phase.)

- 2026-11-27 (Phase 0): program IDs changed from the starter IDs to `breakglass` = `AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB`, `test_vault` = `2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn`. Read the ID from the IDL's `address` field rather than hard-coding it.
