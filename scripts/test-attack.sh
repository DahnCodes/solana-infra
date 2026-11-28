#!/usr/bin/env bash
# Zero-loss attack tests (Phase 3): build test-vault WITH the planted bug,
# run the whole suite against it (tests/attack.ts switches to its attack
# cases when PLANTED_BUG=1), then always rebuild the safe test-vault so the
# buggy .so is never left in target/deploy for `anchor deploy`.
#
#   yarn test:attack
set -uo pipefail
cd "$(dirname "$0")/.."

restore() {
  echo "rebuilding the safe (default) test-vault..."
  if ! anchor build -p test_vault >/dev/null 2>&1; then
    echo "WARNING: could not rebuild the safe test-vault. Run 'anchor build' before deploying." >&2
  fi
}
trap restore EXIT

anchor build -p test_vault -- --features planted-bug || exit 1
PLANTED_BUG=1 anchor test --skip-build
