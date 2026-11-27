# CLAUDE.md

You are building **Breakglass**, an emergency circuit breaker and outflow gate for Solana protocols. Backend only, no frontend.

## Read first
1. `docs/SPEC.md`: what the system must do. This is the source of truth for behavior.
2. `docs/BUILD_PLAN.md`: the phases, in order, each with acceptance tests and a manual check for the human.
3. `docs/PROGRESS.md`: where the build is. Update it at the end of every phase.

## How to work
- One phase at a time, on a branch `phase-N-<name>`, one PR per phase. Don't start the next phase until the human says go.
- Re-read the spec sections a phase lists before coding it.
- Write tests with the code. A phase is done only when every acceptance test in BUILD_PLAN.md passes with the commands listed there.
- Never weaken, skip or delete a test to make it pass.
- After a failing run, re-run only the failing tests while fixing. Run the whole suite again before finishing a phase.
- Put spec defaults in `programs/breakglass/src/constants.rs`, never as magic numbers.
- If the spec is ambiguous, choose the fail-closed reading and record it under "Decisions" in `docs/PROGRESS.md`.

## Hard rules (security)
- The Breakglass program must NEVER hold token authority or transfer user funds. It returns Allow / Hold / Deny. The protected program moves funds.
- Every Breakglass account read by a protocol must be checked for owner and seeds. A protocol must also check `config.protected_program == crate::ID`. Missing or fake accounts make the instruction fail (fail closed).
- The guardian can only slow things down: pause, renew within caps, freeze holds, veto. It can't unpause auto-trips or admin pauses, change config, or move funds.
- Anything that loosens protection or releases funds goes through the timelock. Tightening applies immediately.
- Every state change emits an event via `emit_cpi!`. Event structs in `programs/breakglass/src/events.rs` are a contract with `monitor/`. Change both together.
- `planted-bug` (test-vault feature) is for attack tests only and must never be in default features.
- Never commit keypairs, `.env`, or secrets.

## Commands
```bash
anchor build                       # compile programs
anchor test                        # TS integration tests on a fresh local validator
cargo test -p breakglass           # Rust unit/property tests for the program
cd monitor && cargo test           # monitor tests (separate Cargo workspace)
```

## Toolchain
Anchor 0.31.1 (pinned with `=` in Cargo.toml), Solana CLI 2.1.x, Node 20+. Don't bump versions without asking.
