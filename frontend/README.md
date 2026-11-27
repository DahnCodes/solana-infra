# Breakglass frontend

The web app for Breakglass: a dashboard for protocols, admins and guardians to watch the outflow gate, pauses, held withdrawals and timelocked config changes.

The backend (Anchor program, TypeScript client and monitor) lives in the rest of this repo. The frontend builds against the contract in `../docs/FRONTEND.md` on the `backend` branch.

## Run it

Needs Node 20+ and pnpm.

```bash
pnpm install
pnpm dev        # http://localhost:3000
```

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
