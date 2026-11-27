# Progress

Claude Code updates this file at the end of every phase (see docs/BUILD_PLAN.md).

| Phase | Status | How to test | Notes |
| --- | --- | --- | --- |
| 0 Toolchain and skeleton | In progress | `anchor build && anchor test` | Starter repo |
| 1 Config, roles, pauses | Not started | | |
| 2 Outflow gate and holds | Not started | | |
| 3 Zero-loss mode | Not started | | |
| 4 Timelocks | Not started | | |
| 5 Monitor v1 | Not started | | |
| 6 Guardian bot and screening | Not started | | |
| 7 Attack suite and CI | Not started | | |
| 8 Upgrade vault and co-signer (optional) | Not started | | |

## Decisions

(Ambiguities resolved during the build, with the reason.)

- 2026-11-27: one `backend` branch for all phases instead of a branch per phase. It ships to `main` through a single PR. Requested by the project owner.
- 2026-11-27: the frontend contract lives in `docs/FRONTEND.md` and `clients/ts`. Every phase keeps both in sync (see BUILD_PLAN "API contract rules").

## Breaking changes

(Any change to an event field, account layout, instruction signature, error order or monitor API response that the frontend must react to, with the date and phase.)
