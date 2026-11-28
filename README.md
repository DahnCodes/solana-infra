# Breakglass

Emergency circuit breaker and outflow gate for Solana protocols. An independent guardian can temporarily pause specific operations during a suspected exploit. Every withdrawal passes an on-chain gate that can allow it, hold it, or block it, and no Breakglass role can ever move user funds.

- What it does and why: [`docs/SPEC.md`](docs/SPEC.md)
- How it gets built, phase by phase: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md)
- Where the build is: [`docs/PROGRESS.md`](docs/PROGRESS.md)
- **Building a frontend?** Start at [`docs/FRONTEND.md`](docs/FRONTEND.md): program IDs, PDAs, instructions, events, error codes and the monitor HTTP API, plus the TypeScript client in [`clients/ts`](clients/ts).

## Layout

```
programs/breakglass     on-chain program (Anchor)
programs/test-vault     example protocol that uses Breakglass; has a planted bug behind a feature, for attack tests
crates/breakglass-sdk   helpers a protocol calls to use the gate
clients/ts              TypeScript client for frontends: generated IDL + types, PDA helpers, error codes, event decoding
tests/                  TypeScript integration tests (run by `anchor test`)
scripts/                demo and attack scripts you run by hand
monitor/                off-chain monitor + alerts + guardian bot (separate Cargo workspace)
docs/                   spec, build plan, progress, frontend contract
```

## 1. Install the tools (one time)

These steps are for macOS or Linux. On Windows, install [WSL2](https://learn.microsoft.com/windows/wsl/install) with Ubuntu first and run everything inside it.

**Option A: one command (installs Rust, Solana CLI, Anchor, Node, Yarn)**

```bash
curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
```

Then close and reopen your terminal.

**Option B: step by step**

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI (Agave). 2.1.x matches Anchor 0.31.1
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.21/install)"
# Add the PATH line it prints to your ~/.bashrc or ~/.zshrc, then reopen the terminal

# Anchor via avm (Anchor Version Manager)
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.31.1
avm use 0.31.1

# Node 20+ and Yarn
# install Node from https://nodejs.org (or nvm), then:
npm install -g yarn
```

**Check everything is installed:**

```bash
rustc --version      # 1.79 or newer
solana --version     # solana-cli 2.1.x
anchor --version     # anchor-cli 0.31.1
node --version       # v20 or v22
yarn --version
```

If a link above has moved, the current official steps are at https://solana.com/docs/intro/installation.

## 2. Set up a local wallet (one time)

```bash
solana-keygen new                     # creates ~/.config/solana/id.json (keep the seed phrase safe)
solana config set --url localhost     # point the CLI at your local validator
```

## 3. Build and test

```bash
yarn install            # TypeScript test dependencies
anchor keys sync        # writes YOUR program IDs into lib.rs and Anchor.toml (do this once after cloning)
anchor build            # compiles both programs to target/deploy/*.so
anchor test             # starts a fresh local validator, deploys, runs tests/
```

Expected: `1 passing  initializes a protocol config`.

Rust unit tests and the monitor:

```bash
cargo test -p breakglass
cd monitor && cargo test && cd ..
```

## 4. Run the monitor

```bash
docker compose -f monitor/docker-compose.yml up -d   # local Postgres
cd monitor
cp config.example.toml config.toml   # set vault_token_accounts, RPCs, sinks
cp .env.example .env                 # DATABASE_URL, MONITOR_API_TOKEN, Telegram/webhook secrets
cargo test                           # unit + Postgres tests (needs the Postgres above)
cargo run -- --config config.toml
```

The monitor watches the Breakglass and protected programs over 2+ RPCs and pages on every event that matters, plus unexplained vault drops, program upgrades and dead RPCs. It serves the admin API on `http://127.0.0.1:8080` (see [`docs/FRONTEND.md`](docs/FRONTEND.md) section 7). End-to-end check against a local validator: `yarn ts-node scripts/monitor-e2e.ts`.

## 5. Attack suite and CI

```bash
docker compose -f monitor/docker-compose.yml up -d   # Postgres for the monitor
yarn test:attacks                                     # six attacks against a fresh validator: expect 6/6 PASS
```

CI (`.github/workflows/ci.yml`) runs the lint, the contract drift check, every test suite and the attack suites on each push to `backend`. To run the attacks on devnet with live alerts, follow [`docs/DEVNET.md`](docs/DEVNET.md).

## 6. Run things by hand on a local validator

```bash
solana-test-validator --reset     # terminal 1: leave running
anchor deploy                     # terminal 2
yarn ts-node scripts/<script>.ts  # demo scripts, added phase by phase
```

## Branches

There is one working branch: **`backend`**. Every phase is committed there (commit messages start with `Phase N:`). There are no per-phase branches. When the backend is ready to ship, open one pull request from `backend` into `main`.

```bash
git clone git@github.com:DahnCodes/solana-infra.git
cd solana-infra
git checkout backend
```

Never commit keypairs. `.gitignore` already excludes `*-keypair.json`, `id.json`, `keys/` and `monitor/.env`. The program keypairs in `target/deploy/` are ignored too. Back them up yourself if you deploy to devnet or mainnet, because they control your program IDs.

## For the frontend developer

The backend is built so a frontend can plug in without reading Rust:

1. Read [`docs/FRONTEND.md`](docs/FRONTEND.md). Each instruction, account, event and endpoint is marked live (✅) or planned (🔜, with the phase that adds it).
2. Use the TypeScript client in `clients/ts`. It has the generated IDL and types (`clients/ts/idl/`), PDA helpers, scope masks, the error code table and event decoding.
3. Run a local validator with the programs deployed (section 6) and point the app at `http://127.0.0.1:8899`.

Every phase keeps the contract in sync. `scripts/sync-client.sh` refreshes the IDL and fails if the client or the doc drifted from the program. In CI, `scripts/sync-client.sh --check` does the same check.

## Building with Claude Code

Open the repo on the `backend` branch in Claude Code and say:

> Read CLAUDE.md, then do Phase 0 of docs/BUILD_PLAN.md.

After each phase, run the phase's **Manual check** yourself, then tell Claude Code to start the next phase. Claude Code commits each phase to `backend`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `anchor build` says a crate needs a newer `rustc` or `edition2024` | Your Solana platform tools are older than a dependency. Run `cargo update -p <crate> --precise <older version>` for the crate it names, or upgrade the Solana CLI. Ask Claude Code to do it. |
| `Error: Program ID mismatch` / `DeclaredProgramIdMismatch` | Run `anchor keys sync`, then `anchor build` again. |
| `anchor test` hangs on "waiting for validator" | Make sure no other `solana-test-validator` is running (`pkill solana-test-validator`). |
| `Attempt to debit an account but found no record of a prior credit` | Your wallet has no SOL on that cluster. Run `solana airdrop 2` (localnet or devnet). |
| Version warnings between anchor-cli and anchor-lang | Both must be 0.31.1: `avm use 0.31.1`. |
