# scripts/

Helper and demo scripts that you run by hand against a local validator or devnet. Each phase of `docs/BUILD_PLAN.md` adds one:

| Script | Phase | What it shows |
| --- | --- | --- |
| `demo-pause.ts` | 1 | Guardian pause blocks a withdraw, unpause restores it |
| `demo-outflow.ts` | 2 | Allow / Hold / auto-trip in action |
| `demo-common.ts` | 1–2 | Shared setup for the demos (not run directly) |
| `test-attack.sh` | 3 | `yarn test:attack`: full suite on the planted-bug build, then rebuilds the safe test-vault |
| `gen-fixtures.js` | 2 | Regenerates `tests/fixtures/` (run with `node`, after `anchor keys sync`) |
| `attack-big-drain.ts` | 3 | Planted bug can't drain the vault |
| `demo-timelock.ts` | 4 | Proposals wait, early execute fails, guardian veto works, tightening applies at once |
| `squads-propose.ts` | 4 | `propose_config` through a Squads v4 multisig (devnet by default) |
| `attack-screened.ts` | 6 | Guardian bot freezes attacker withdrawals |
| `attacks/*.ts` | 7 | Full attack suite, `yarn test:attacks` |

Run with: `yarn ts-node scripts/<name>.ts` (local validator running, programs deployed).
