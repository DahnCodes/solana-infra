# Breakglass

Emergency circuit breaker and outflow gate for Solana protocols. An independent guardian can temporarily pause specific operations during a suspected exploit. Every withdrawal passes an on-chain gate that can allow it, hold it, or block it, and no Breakglass role can ever move user funds.

- What it does and why: [`docs/SPEC.md`](docs/SPEC.md)
- How it gets built, phase by phase: [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md)
- Where the build is: [`docs/PROGRESS.md`](docs/PROGRESS.md)

## Layout

```
programs/breakglass     on-chain program (Anchor)
programs/test-vault     example protocol that uses Breakglass; has a planted bug behind a feature, for attack tests
crates/breakglass-sdk   helpers a protocol calls to use the gate
tests/                  TypeScript integration tests (run by `anchor test`)
scripts/                demo and attack scripts you run by hand
monitor/                off-chain monitor + alerts + guardian bot (separate Cargo workspace)
docs/                   spec, build plan, progress
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

## 4. Run the monitor (skeleton)

```bash
cd monitor
cp config.example.toml config.toml
cp .env.example .env
cargo run -- --config config.toml
```

For now it only starts the pipeline and heartbeats. Real ingestion and alerts arrive in Phase 5 of the build plan.

## 5. Run things by hand on a local validator

```bash
solana-test-validator --reset     # terminal 1: leave running
anchor deploy                     # terminal 2
yarn ts-node scripts/<script>.ts  # demo scripts, added phase by phase
```

## Connect to your GitHub repo

```bash
git init
git add .
git commit -m "Breakglass starter"
git branch -M main
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Never commit keypairs. `.gitignore` already excludes `*-keypair.json`, `id.json`, `keys/` and `monitor/.env`. The program keypairs in `target/deploy/` are ignored too. Back them up yourself if you deploy to devnet or mainnet, because they control your program IDs.

## Building with Claude Code

Open the repo in Claude Code and say:

> Read CLAUDE.md, then do Phase 0 of docs/BUILD_PLAN.md.

After each phase, run the phase's **Manual check** yourself, then tell Claude Code to start the next phase.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `anchor build` says a crate needs a newer `rustc` or `edition2024` | Your Solana platform tools are older than a dependency. Run `cargo update -p <crate> --precise <older version>` for the crate it names, or upgrade the Solana CLI. Ask Claude Code to do it. |
| `Error: Program ID mismatch` / `DeclaredProgramIdMismatch` | Run `anchor keys sync`, then `anchor build` again. |
| `anchor test` hangs on "waiting for validator" | Make sure no other `solana-test-validator` is running (`pkill solana-test-validator`). |
| `Attempt to debit an account but found no record of a prior credit` | Your wallet has no SOL on that cluster. Run `solana airdrop 2` (localnet or devnet). |
| Version warnings between anchor-cli and anchor-lang | Both must be 0.31.1: `avm use 0.31.1`. |
