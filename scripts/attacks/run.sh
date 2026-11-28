#!/usr/bin/env bash
# The attack suite: `yarn test:attacks`.
#
# Starts a fresh solana-test-validator with both programs (test-vault built
# with the planted bug), creates every attack's vault (setup.ts), starts one
# monitor with the guardian bot watching them all, runs the six attacks, and
# prints `N/6 PASS`. Exits non-zero unless all pass. Always stops what it
# started and rebuilds the safe test-vault.
#
# Needs: anchor 0.31.1, solana 2.1.x, node/yarn, Postgres at DATABASE_URL
# (default: the docker-compose one), ports 8899/8900, 18090, 18095, 48899/48900 free.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
export PATH="$HOME/.avm/bin:$PATH"

for port in 8899 8900 18090 18095 48899 48900; do
  if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    echo "port $port is in use (a running validator or monitor?): stop it first" >&2
    exit 2
  fi
done

WORK=$(mktemp -d)
VALIDATOR_PID=""
MONITOR_PID=""
cleanup() {
  [[ -n $MONITOR_PID ]] && kill "$MONITOR_PID" 2>/dev/null
  [[ -n $VALIDATOR_PID ]] && kill "$VALIDATOR_PID" 2>/dev/null
  echo "rebuilding the safe (default) test-vault..." >&2
  anchor build -p test_vault >/dev/null 2>&1 || echo "WARNING: rebuild the safe test-vault with 'anchor build'" >&2
  echo "logs: $WORK" >&2
}
trap cleanup EXIT

echo "building (test-vault with --features planted-bug)..." >&2
anchor build >/dev/null 2>&1 || { echo "anchor build failed" >&2; exit 1; }
anchor build -p test_vault -- --features planted-bug >/dev/null 2>&1 || { echo "planted-bug build failed" >&2; exit 1; }
(cd monitor && cargo build -q) || { echo "monitor build failed" >&2; exit 1; }

WALLET_FILE=${ANCHOR_WALLET:-$HOME/.config/solana/id.json}
WALLET=$(solana-keygen pubkey "$WALLET_FILE")
BG=$(node -p 'require("./target/idl/breakglass.json").address')
TV=$(node -p 'require("./target/idl/test_vault.json").address')

echo "starting a fresh validator..." >&2
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --mint "$WALLET" \
  --upgradeable-program "$BG" target/deploy/breakglass.so "$WALLET" \
  --upgradeable-program "$TV" target/deploy/test_vault.so "$WALLET" \
  >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
for _ in $(seq 1 60); do solana -u localhost cluster-version >/dev/null 2>&1 && break; sleep 1; done
solana -u localhost cluster-version >/dev/null 2>&1 || { echo "validator didn't start" >&2; exit 1; }
sleep 2

export ANCHOR_PROVIDER_URL=http://127.0.0.1:8899
export ANCHOR_WALLET=$WALLET_FILE
export ATTACK_FIXTURES=$WORK/fixtures.json
export DATABASE_URL=${DATABASE_URL:-postgres://breakglass:breakglass@localhost:5432/breakglass}
export MONITOR_API=http://127.0.0.1:18090

echo "creating the attack vaults..." >&2
VAULTS=$(yarn -s ts-node scripts/attacks/setup.ts 2>>"$WORK/setup.log") || { cat "$WORK/setup.log" >&2; exit 1; }
PROTOCOL=$(node -p "require('$ATTACK_FIXTURES').protocol")
VAULT_LIST=$(echo "$VAULTS" | sed 's/.*/"&"/' | paste -sd, -)
GUARDIAN_FILE=$ROOT/.anchor/demo-guardian-keypair.json
solana -u localhost airdrop 10 "$(solana-keygen pubkey "$GUARDIAN_FILE")" >/dev/null

cat >"$WORK/monitor.toml" <<TOML
[network]
rpc_urls = ["http://127.0.0.1:8899"]
ws_urls = ["ws://127.0.0.1:8900"]
[protocol]
name = "$PROTOCOL"
breakglass_program = "$BG"
protected_program = "$TV"
vault_token_accounts = [$VAULT_LIST]
[detectors]
window_warning_pct = 50
window_high_pct = 80
heartbeat_timeout_secs = 30
[alerts]
sinks = ["stdout"]
critical_repage_secs = 120
[api]
bind = "127.0.0.1:18090"
[bot]
enabled = true
pause_scopes = [1]
TOML
# exec: the PID we track is the monitor itself, so cleanup can stop it.
(cd "$WORK" && GUARDIAN_KEYPAIR_PATH=$GUARDIAN_FILE RUST_LOG=info \
  exec "$ROOT/monitor/target/debug/breakglass-monitor" --config "$WORK/monitor.toml" \
  >"$WORK/monitor.out" 2>"$WORK/monitor.log") &
MONITOR_PID=$!
for _ in $(seq 1 60); do grep -q "ingestor subscribed" "$WORK/monitor.log" 2>/dev/null && break; sleep 0.5; done
grep -q "guardian bot running" "$WORK/monitor.log" || { echo "monitor/bot didn't start:" >&2; tail -20 "$WORK/monitor.log" >&2; exit 1; }

# bypass-check first: it needs the bot's one pause before the guardian's 6h cooldown.
ATTACKS=(bypass-check big-drain many-small rogue-guardian stolen-admin monitor-outage)
passed=0
for a in "${ATTACKS[@]}"; do
  echo "--- $a" >&2
  line=$(yarn -s ts-node "scripts/attacks/$a.ts" 2>>"$WORK/$a.log" | tail -1)
  [[ -z $line ]] && line="FAIL: $a: no result (see $WORK/$a.log)"
  echo "$line"
  [[ $line == PASS:* ]] && passed=$((passed + 1))
done
echo "$passed/${#ATTACKS[@]} PASS"
[[ $passed -eq ${#ATTACKS[@]} ]]
