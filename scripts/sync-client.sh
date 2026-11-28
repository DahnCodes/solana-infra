#!/usr/bin/env bash
# Copy the generated IDL + TS type into clients/ts/idl so the frontend can use
# them without building Rust, then check the hand-written client still matches
# the program. Run after every `anchor build` that changes the program.
#
#   scripts/sync-client.sh          # copy + check
#   scripts/sync-client.sh --check  # CI: fail if clients/ts is stale (no writes)
set -euo pipefail
cd "$(dirname "$0")/.."

src_json=target/idl/breakglass.json
src_ts=target/types/breakglass.ts
dst=clients/ts/idl

if [[ ! -f $src_json || ! -f $src_ts ]]; then
  echo "missing $src_json or $src_ts: run 'anchor build' first" >&2
  exit 1
fi

if [[ ${1:-} == "--check" ]]; then
  diff -q "$src_json" "$dst/breakglass.json" && diff -q "$src_ts" "$dst/breakglass.ts" || {
    echo "clients/ts/idl is stale: run scripts/sync-client.sh and commit" >&2
    exit 1
  }
else
  cp "$src_json" "$dst/breakglass.json"
  cp "$src_ts" "$dst/breakglass.ts"
  echo "copied IDL and types to $dst"
fi

node scripts/check-client-drift.js
