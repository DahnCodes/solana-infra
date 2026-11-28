# CLAUDE.md

You are building **Breakglass**, an emergency circuit breaker and outflow gate for Solana protocols. Backend only, no frontend in this repo. A separate frontend consumes the backend through the contract in `docs/FRONTEND.md`, so that contract must always match the code.

## Read first
1. `docs/SPEC.md`: what the system must do. This is the source of truth for behavior.
2. `docs/BUILD_PLAN.md`: the phases, in order, each with acceptance tests and a manual check for the human.
3. `docs/PROGRESS.md`: where the build is. Update it at the end of every phase.
4. `docs/FRONTEND.md`: the API contract the frontend builds against (IDs, PDAs, instructions, events, errors, monitor HTTP API).

## How to work
- All work goes on the single `backend` branch. No branch per phase. Commit each phase on `backend` with a message starting `Phase N:`, and push. `backend` merges to `main` through one PR when the human decides to ship. Don't start the next phase until the human says go.
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

## API contract rules (frontend-ready)
- Any change to an instruction, account, event, error or the monitor HTTP API updates `docs/FRONTEND.md` in the same commit, and flips its status from 🔜 to ✅ when it lands.
- After `anchor build`, run `scripts/sync-client.sh` and commit `clients/ts/idl/`. It also runs `scripts/check-client-drift.js`, which must pass.
- `errors.rs` is append-only: never reorder, rename or remove a variant, because codes are 6000 + position.
- Changing an event field or account layout is a breaking change for the frontend: note it under "Breaking changes" in `docs/PROGRESS.md`.
- Keep `clients/ts/src` (seeds, PDA helpers, error table) matching the Rust.

## Commands
```bash
anchor build                       # compile programs
anchor test                        # TS integration tests on a fresh local validator
cargo test -p breakglass           # Rust unit/property tests for the program
cd monitor && cargo test           # monitor tests (separate Cargo workspace)
scripts/sync-client.sh             # copy IDL to clients/ts/idl + drift check (after anchor build)
node scripts/check-client-drift.js # drift check only, no build needed
```

## Toolchain
Anchor 0.31.1 (pinned with `=` in Cargo.toml), Solana CLI 2.1.x, Node 20+. Don't bump versions without asking.
