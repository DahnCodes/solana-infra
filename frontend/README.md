# Breakglass frontend

The web app for Breakglass: a dashboard for protocols, admins and guardians to watch the outflow gate, pauses, held withdrawals and timelocked config changes.

The backend (Anchor program, TypeScript client and monitor) lives in the rest of this repo. The frontend builds against the contract in `../docs/FRONTEND.md` on the `backend` branch.

## Run it

Needs Node 20+ and pnpm.

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

## Configuration

The app reads its settings from `NEXT_PUBLIC_` environment variables, through `src/lib/env.ts`. Every one has a safe default, so the app runs without any setup, in mock mode.

To change a setting, copy `.env.example` to `.env.local` and edit it. `.env.local` stays out of git. Restart `pnpm dev` after a change.

| Variable                            | Default                         | What it is                                              |
| ----------------------------------- | ------------------------------- | ------------------------------------------------------- |
| `NEXT_PUBLIC_DATA_MODE`             | `mock`                          | `mock` uses sample data; `live` reads the cluster below |
| `NEXT_PUBLIC_SOLANA_CLUSTER`        | `devnet`                        | `localnet`, `devnet` or `mainnet-beta`                  |
| `NEXT_PUBLIC_RPC_URL`               | `https://api.devnet.solana.com` | RPC endpoint for that cluster                           |
| `NEXT_PUBLIC_BREAKGLASS_PROGRAM_ID` | from `docs/FRONTEND.md`         | The Breakglass program                                  |
| `NEXT_PUBLIC_PROTECTED_PROGRAM_ID`  | the repo's `test_vault`         | The protocol Breakglass protects                        |
| `NEXT_PUBLIC_USDC_MINT`             | not set                         | Token mint of the demo vault, filled in at checkpoint B |
| `NEXT_PUBLIC_MONITOR_API_URL`       | `http://127.0.0.1:8080`         | Off-chain monitor API                                   |

A value that is set but invalid (a typo in the cluster, a malformed address) stops the app with a message naming the variable.

## Scripts

| Command             | What it does                                        |
| ------------------- | --------------------------------------------------- |
| `pnpm dev`          | Starts the dev server                               |
| `pnpm build`        | Builds for production                               |
| `pnpm lint`         | Runs ESLint                                         |
| `pnpm typecheck`    | Runs the TypeScript compiler without emitting files |
| `pnpm format`       | Formats every file with Prettier                    |
| `pnpm format:check` | Fails if any file isn't formatted                   |
| `pnpm check`        | Lint, typecheck and format check together           |

Run `pnpm check` before every commit.

## Folders

```
src/
  app/          routes, layouts and pages (Next.js App Router)
  components/   UI components shared across pages
  hooks/        React hooks, mostly for reading and writing Breakglass data
  lib/          plain TypeScript: config, data clients, formatting helpers
```

## How we build

We work through a step-by-step checklist, one commit per step, named after the step (for example `0.2 Lint, format and folders`). See the build checklist sheet for the order and what each step needs first.
