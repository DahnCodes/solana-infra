# Devnet runbook: deploy, then run the attack suite with live alerts

This is the Phase 7 manual check, and part of the backend's definition of done: a devnet run of all six attacks with live alerts, recorded at the bottom of this file.

Locally, `yarn test:attacks` does all of this against a throwaway validator. On devnet you run the same scripts one by one against a real cluster, with the monitor paging Telegram.

> **Devnet only.** The suite needs test-vault built with the `planted-bug` feature, which contains deliberate vulnerabilities. Never deploy that build anywhere that holds real value.

## 0. What you need

- The toolchain from the README (Anchor 0.31.1, Solana 2.1.x, Node 20+, Docker), with `~/.avm/bin` first on `PATH`.
- **About 15 devnet SOL** in your wallet. Deploying needs roughly 4.5 SOL for Breakglass (622 KB) and 3 SOL for test-vault (413 KB), plus temporary buffer space during each deploy (refunded). The stolen-admin attack redeploys test-vault once more. Get SOL from `solana airdrop 2` (rate-limited) or https://faucet.solana.com.
- **Two devnet RPC providers**, each with HTTP and websocket URLs (e.g. `https://api.devnet.solana.com` plus a free devnet endpoint from another provider). The monitor needs 2+ independent providers.
- A Telegram bot token and chat ID (see BUILD_PLAN Phase 5's manual check).

```bash
solana config set --url devnet
solana balance                 # ~15 SOL
```

## 1. Build and deploy

```bash
anchor build                                            # breakglass + IDL
anchor build -p test_vault -- --features planted-bug    # the vulnerable test-vault (devnet only)
anchor deploy --provider.cluster devnet
```

`anchor deploy` uses your program keypairs in `target/deploy/`. **Back them up**: they own the program IDs. Your wallet becomes the upgrade authority, which `initialize_config` requires.

## 2. Register test-vault and create the attack vaults

`setup.ts` registers test-vault with Breakglass if it isn't yet. It registers your wallet as admin and two local guardians (`.anchor/demo-guardian-keypair.json` for the bot, `.anchor/demo-guardian2-keypair.json` for the rogue-guardian attack). It then creates the eight attack vaults, each with a victim's 10,000-token deposit, and prints their token accounts.

```bash
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ATTACK_FIXTURES=$PWD/.anchor/attack-fixtures-devnet.json
export ATTACK_PROTOCOL=devnet-attacks
yarn ts-node scripts/attacks/setup.ts > .anchor/devnet-vaults.txt
cat .anchor/devnet-vaults.txt                           # 8 vault token accounts
solana transfer "$(solana-keygen pubkey .anchor/demo-guardian-keypair.json)" 1 --allow-unfunded-recipient
```

Off localnet the scripts fund new wallets by transfer from your wallet (0.05 SOL each), not airdrops.

## 3. Run the monitor and the guardian bot

```bash
docker compose -f monitor/docker-compose.yml up -d
cd monitor
cp config.example.toml config.devnet.toml
cp .env.example .env
```

In `config.devnet.toml`:

```toml
[network]
rpc_urls = ["https://api.devnet.solana.com", "https://<second-provider-devnet-rpc>"]
ws_urls  = ["wss://api.devnet.solana.com",  "wss://<second-provider-devnet-ws>"]

[protocol]
name = "devnet-attacks"              # must equal ATTACK_PROTOCOL
breakglass_program = "<target/idl/breakglass.json address>"
protected_program = "<target/idl/test_vault.json address>"
vault_token_accounts = [ ...the 8 accounts from .anchor/devnet-vaults.txt, quoted... ]

[alerts]
sinks = ["stdout", "telegram"]
explorer_tx_url = "https://explorer.solana.com/tx/{signature}?cluster=devnet"

[bot]
enabled = true
pause_scopes = [1]
```

In `.env`, set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `MONITOR_API_TOKEN` and `GUARDIAN_KEYPAIR_PATH=<repo>/.anchor/demo-guardian-keypair.json`. Then:

```bash
cargo run --release -- --config config.devnet.toml
```

Wait for `guardian bot running` and two `ingestor subscribed` lines.

## 4. Run the attacks

In another terminal, from the repo root, with the variables from step 2 still set:

```bash
export MONITOR_API=http://127.0.0.1:8080
for a in bypass-check big-drain many-small rogue-guardian stolen-admin; do
  yarn -s ts-node scripts/attacks/$a.ts 2>>.anchor/devnet-attacks.log
done
```

Each prints one `PASS: ...` or `FAIL: ...` line. **Order matters:** bypass-check needs the bot's first pause, and after that pause the bot's guardian key is in its 6h on-chain cooldown.

**monitor-outage** needs a TCP proxy in front of a plain-HTTP RPC, which devnet providers (HTTPS only) don't offer. Run it against a local validator instead: `yarn test:attacks` includes it. The property it checks, that the on-chain gate caps a drain with no monitor at all, doesn't depend on the cluster.

Watch Telegram while they run. You should get:

| Attack | Pages you should see |
| --- | --- |
| bypass-check | CRITICAL balance_delta (unexplained outflow) |
| big-drain | CRITICAL blocked_exploit (InvariantViolated); HIGH fresh_address / deposit_history |
| many-small | WARNING / HIGH window_usage (50% / 80%); CRITICAL pause_trip (cap tripped) |
| rogue-guardian | HIGH pause_trip (the rogue's pause), HIGH config_change (guardian removed) |
| stolen-admin | HIGH config_change for each of 5 proposals; CRITICAL program_upgrade |

The bot's actions are at `GET /actions`; everything else is at `GET /incidents`.

### Running the suite again

- The **rogue-guardian** attack ends with the admin removing guardian 2.
- The **bot's guardian** is in cooldown for 6h after bypass-check.

So a second run needs either a new registration or a 6h wait. For a new registration, give test-vault a new program ID (`solana-keygen new -o target/deploy/test_vault-keypair.json --force && anchor keys sync`), rebuild with the bug, redeploy, and repeat from step 2 with a new `ATTACK_PROTOCOL`.

## 5. Clean up

```bash
solana program close <test_vault program id> --bypass-warning    # reclaims its SOL
solana program close <breakglass program id> --bypass-warning
docker compose -f monitor/docker-compose.yml down
```

## Results

Record each devnet run here: date, commit, the six result lines, which Telegram pages arrived, and anything unexpected.

| Date | Commit | bypass-check | big-drain | many-small | rogue-guardian | stolen-admin | monitor-outage (localnet) | Pages received | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | |
