# Generated files: do not edit by hand

`scripts/sync-client.sh` copies these here after `anchor build`:

- `breakglass.json`: the Anchor IDL (instructions, accounts, events, errors, program address)
- `breakglass.ts`: the matching TypeScript type for `Program<Breakglass>`

They appear once Phase 0 builds, and every phase that changes the program must re-run the sync and commit the result. CI fails if they are stale.
