@AGENTS.md

# CLAUDE.md (frontend)

You are building the **frontend** of **Breakglass**, a web app on top of an existing Solana backend. Work only inside `frontend/`. This file is the source of truth for frontend work. Where the root `../CLAUDE.md` says "backend only, no frontend", that applies to the backend; it does not apply here.

## What Breakglass is

Breakglass is an emergency circuit breaker and outflow gate for Solana protocols. It is a **gate and a ledger, never a custodian**: it never holds or moves user funds.

- A protected protocol (in the demo, the repo's `test_vault` program) calls Breakglass on every withdrawal. Breakglass answers **Allow**, **Hold** or **Deny**, and the protocol moves its own funds.
- **Outflow limiter:** one per token mint. A rolling window (12 sub-buckets) with a cap of `min(capAbsolute, capBpsOfVault × vault balance)`. Crossing the cap returns Hold and auto-pauses the scope (auto-trip).
- **Holds:** a withdrawal at or above the large-withdrawal threshold (or over the instant allowance, or over the cap) becomes a `PendingWithdrawal` with a `releaseAt` time. The guardian can freeze it, the admin can reject it, the user claims it after `releaseAt`. Releasing a frozen hold goes through the timelock.
- **Pauses:** up to 64 named scopes (bitmask). Kinds: guardian, auto-trip, admin. Every pause has `pausedUntil`. Some scopes are unpausable ("always open"). Guardians have a cooldown and a monthly pause budget.
- **Timelocked config:** anything that loosens protection (raise limits, add guardian, change admin, release a hold, change policy) is proposed by the admin, waits out the timelock (default 48h), can be vetoed by the guardian, and then anyone executes it. Tightening applies at once.
- **Monitor:** an off-chain service that turns every gate event into alerts and incidents, with an HTTP API.

**Core guarantee to show in the UI:** an attacker can take at most one window's cap before the gate trips by itself, and any withdrawal over the threshold waits out a public hold.

### Roles (what the UI must respect)

| Role     | Usually                               | Can                                                                                   | Can never                                                     |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Admin    | Squads multisig                       | Propose config changes (timelocked), unpause anything, remove guardians, reject holds | Move funds, skip the timelock                                 |
| Guardian | Independent security party or its bot | Pause within limits, renew within cap, lift its own pause, freeze holds, veto changes | Unpause auto-trips or admin pauses, change config, move funds |
| User     | Protocol user                         | Withdraw through the protocol, claim their own hold after `releaseAt`                 |                                                               |
| Anyone   | Any wallet                            | Execute a config change after `executableAt`                                          |                                                               |

### The hackathon

Dev3pack Solana hackathon, ending Nov 28 2026. Submission needs: a Solana program in Rust deployed to at least devnet, contract addresses in the README, a public repo with setup steps, a demo video under 3 minutes, and a **live demo link**. This frontend is the live demo. Pitch track: autonomous agents and treasuries with spending limits; security tooling.

## The contract you build against

The backend publishes a frontend contract on the **`backend` branch**. Read it before any data work:

```bash
git fetch origin backend
git show origin/backend:docs/FRONTEND.md      # IDs, PDAs, accounts, instructions, events, errors, monitor API
git show origin/backend:docs/SPEC.md          # behaviour
git show origin/backend:docs/PROGRESS.md      # what the backend has shipped
```

- Each item there is marked ✅ (live) or 🔜 (planned, with the backend phase that adds it). Build every feature against the documented shape now, in mock mode. Switch it to live data only when it is ✅.
- The typed client package is `clients/ts` (`@breakglass/client`) on the backend branch: generated IDL and types, PDA helpers, scope masks, error parsing, `emit_cpi!` event decoding. Events are **not** visible to `program.addEventListener`; use the client's `fetchEvents` / `onBreakglassEvents`, or the monitor API.
- Versions must match the program: `@coral-xyz/anchor` **0.31.1**, `@solana/web3.js` 1.x.
- Amounts are `u64`: use `BN` or `bigint`, never JS `number`. Monitor API amounts are decimal strings. Times are unix seconds on-chain, RFC 3339 in the monitor API.
- Pause expiry is lazy: a scope is paused only if some entry has `scope === s && pausedUntil > now`.
- Error codes 6000+ come with ready-made UI messages in FRONTEND.md section 8. A protected protocol's errors also start at 6000, so check which program failed before mapping.

Never edit backend files (`programs/`, `crates/`, `clients/`, `monitor/`, `docs/`, `tests/`, `scripts/`). If the contract seems wrong or missing something, stop and tell the human.

## How we work (guidelines)

1. **One step at a time, top to bottom** through the checklist below. Don't start a step until everything in its "Needs first" is done.
2. **A step is done only when its "Done when" is true.** Then tick it (see "The checklist" below for where).
3. **One commit per step**, message starting with the step number and title, for example `0.3 Env config`. Push to the `frontend` branch.
4. **Run `pnpm check` before every commit** (lint, typecheck, Prettier, tests). Never commit with it failing, and never weaken a lint rule or a type to make it pass.
5. **Stop at every checkpoint** (A, B, C). Tell the human exactly what you need from the backend before continuing.
6. **Mock first, live later.** Every screen is built on mock data behind one client interface. Live wiring happens in phase 6 by switching `NEXT_PUBLIC_DATA_MODE`.
7. **One source of truth for data shapes.** Mock types mirror `docs/FRONTEND.md` exactly (field names as camelCase TS). After checkpoint A they come from the generated IDL types.
8. **Design tokens only.** After phase 1, every screen uses the tokens and base components. No one-off colours, sizes or buttons.
9. **Consult the installed design skills before any design work** (choosing a direction, tokens, components, screens, restyling). This is a standing preference of the human.
10. **Must before Later.** Later rows wait until every Must row is ticked.
11. **Next.js 16 has breaking changes.** Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code (see AGENTS.md).
12. Ask before adding a dependency that isn't obviously needed by the current step.

## Stack and tooling

- Next.js **16.4.6** (App Router, `src/` folder, `cacheComponents` and `partialPrefetching` on in `next.config.ts`), React 19.3, TypeScript, Tailwind CSS 4 (via `@tailwindcss/turbopack`).
- **pnpm** (not npm or yarn) inside `frontend/`. The backend uses yarn in its own folders; leave that alone.
- ESLint (Next core-web-vitals + TypeScript) with `eslint-config-prettier`; Prettier with `prettier-plugin-tailwindcss` (double quotes, trailing commas, same as the backend).
- Scripts: `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm format:check`, `pnpm test`, `pnpm check`.
- Config: `src/lib/env.ts` reads every `NEXT_PUBLIC_` variable by name (so Next inlines it), with safe defaults; invalid values throw. Copy `.env.example` to `.env.local` to override. Never put secrets in `NEXT_PUBLIC_` variables.
- The human's machine is **Windows** (PowerShell). If `pnpm` is blocked with "running scripts is disabled", run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` once, or use `pnpm.cmd`.
- Backend toolchain, if you need a local validator: Anchor 0.31.1, Solana CLI 2.1.21, Node 20+.

### Folders

```
src/
  app/          routes, layouts and pages (App Router)
  components/   shared UI components
  hooks/        React hooks, mostly for reading and writing Breakglass data
  lib/          plain TypeScript: env, data clients, formatting helpers
```

## Current state (Nov 27 2026)

- Branch `frontend` on `DahnCodes/solana-infra`. Last commit: `4.1 App shell`.
- **0.1** to **0.4** done. The setup-check page at `/` lists the config, and a `.env.local` value overrides the defaults.
- pnpm 12 refuses packages published less than 24 hours ago (`minimumReleaseAge`). Keep the policy; if a fresh version is needed, widen the range in `package.json` instead of adding an exclusion.
- `next.config.ts` has `experimental.agentFeedback` on, so `next dev` appends a feedback block to `AGENTS.md`. The human chose to keep the setting, and the block is committed.
- **1.1** done: the human chose a monochrome direction modelled on the Parallel dashboard, with charcoal as the primary colour, Schibsted Grotesk as the main face and Montserrat SemiBold and Light. It is written down in `DESIGN.md`; follow it for all design work. Artific was rejected (personal-use trial licence, incomplete character set).
- After every finished step, tick it on the checklist sheet and in the table below (the human's standing request).
- **1.2** done: every colour, type size, radius and shadow is in `src/app/tokens.css` (light and dark via `light-dark()`); Tailwind's defaults are switched off, so only token utilities exist. Both fonts load through `next/font/google` and have tabular figures (`tabular-nums`).
- If a CSS change doesn't show up in `pnpm dev`, restart the dev server; Turbopack once kept serving a stale `globals.css`.
- **1.3** done: `src/components/` has `Button`, `Input`, `Panel`/`InsetPanel`, `Badge`, `Dialog` (native `<dialog>`), `ToastProvider`/`useToast`/`ToastCard`, `Countdown` and `Amount`; `/components` shows each in light and dark. Icons are `lucide-react` (approved). Helpers: `lib/cx.ts`, `lib/format.ts` (`formatUnits` for u64 base units, `formatDuration`, `formatDateTime`), `hooks/use-now.ts`.
- Live time: never read the clock during server render (Cache Components rejects it). `useNow()` returns null on the server and ticks in the browser; `Countdown` also takes a `now` prop for the mock clock in 2.3.
- A `data-theme` on an inner element works because `tokens.css` declares the tokens again on `[data-theme]` (Tailwind compiles `light-dark()` into variables that resolve where declared). Keep that selector if you edit the file.
- The human watches the app in the Browser pane preview tab; leave it on the page being worked on.
- **2.1** done: the data model is in `src/lib/breakglass/` (`primitives.ts`, `accounts.ts`, `events.ts`, `monitor.ts`, re-exported from `index.ts`). Field names match the IDL exactly (checked against `clients/ts/idl/breakglass.json` at backend commit `e52f9cd`); u64 is `bigint`, unix times are `number`, keys are base58 strings, Rust enums are string literals. Monitor types keep the API's snake_case JSON. `PendingConfig`'s `ConfigAction` fields are provisional until backend phase 4 documents them (raise at checkpoint A).
- **2.2** done: `BreakglassClient` in `src/lib/breakglass/client.ts` lists every read (clock, configs, pause state, limiters, token balance, holds, pending changes, guardian ledgers, test-vault position, events, incidents) and every write (all 14 non-CPI Breakglass instructions, test-vault `deposit`/`withdraw`, monitor `ackIncident`), plus `subscribe` for change notifications. Writes sign with the connected wallet and reject with `ClientError`. `check_scope`/`check_outflow` are CPI-only, reached through `withdraw` and `claimHeld`.
- **2.3** done: `src/lib/breakglass/rules/` ports the program's limiter and pause logic line for line from the backend Rust (`limiter.rs`, `pause_logic.rs`, `gate.rs`, `check_outflow.rs`, `claim_held.rs` at `e52f9cd`); screens can use its read helpers (`windowUsage`, `bucketsOldestFirst`, `effectiveCap`, `isScopePaused`, `budgetLeft`, `cooldownEnds`, …). `mock/engine.ts` is a synchronous in-memory chain (every write atomic: a failed one changes nothing); `mock/client.ts` (`MockClient`) wraps it in `BreakglassClient` and adds `setWallet` (role switcher, `MOCK_WALLETS` in `mock/seed.ts`), `advanceClock`, `reset` and 350 ms latency. `mock/seed.ts` builds the demo state by replaying actions at past times. `getBreakglassClient()` / `getMockClient()` in `create-client.ts` pick by data mode. Timelocked changes follow our provisional reading of phase 4 (`releaseHeld` proposes a `releaseHeld` action; `cancelConfig` closes the account and emits no event).
- Tests: `pnpm test` (Node's built-in runner, no extra dependency) runs `src/**/*.test.ts`; `pnpm check` now includes it. Files under `src/lib/breakglass` import each other with explicit `.ts` extensions (tsconfig `allowImportingTsExtensions`) so Node can run them, and must not use the `@/` alias.
- **2.4** done: `src/hooks/use-client-query.ts` (`useClientQuery(key, read)`: reads in the browser only, re-reads on every client `subscribe` notification, keeps data while refreshing), `src/hooks/use-breakglass.ts` (one hook per read: `useProtocol`, `usePauseState`, `useFlowLimiters`, `useTokenBalance`, `useHolds`, `usePendingChanges`, `useGuardianLedger`, `usePosition`, `useEvents`, `useIncidents`, `useIncident`; plus `useChainNow` (cluster time, ticking, follows the mock clock), `useConnectedWallet`, `roleOf`, `useMockControls`), and `src/hooks/use-write.ts` (`useWrite` with pending and error state). No data library added. `/mock` is a temporary page that exercises them (wallet switcher, clock, withdraw, freeze, reject, claim, execute, veto); the dashboard (4.4) replaces it.
- **3.1** done: the human confirmed Phantom connects and disconnects on devnet. `@solana/wallet-adapter-react`, `@solana/wallet-adapter-base` and `@solana/web3.js` 1.x are installed (approved); `wallet-adapter-react-ui` was left out on purpose because its modal brings its own colours. `SolanaProvider` (root layout) finds Wallet Standard wallets (Phantom, Solflare, Backpack) by itself, autoconnects, and in mock mode makes a connected real wallet the wallet the mock acts as. `WalletButton` is our own picker and account dialog. `pnpm-workspace.yaml` declines the install scripts of `bufferutil` and `utf-8-validate` (optional WebSocket speed-ups); keep it.
- `Dialog` handles Escape itself: the in-app browser never fires the native `close` event, which had left dialogs unable to reopen after Escape (fixed in 3.1).
- **3.2** done: `NetworkBadge` (cluster from `NEXT_PUBLIC_SOLANA_CLUSTER`, plus "Mock data" in mock mode) and `NetworkWarning` (root layout, every page) in `src/components/network/`. The warning shows when the app is set to mainnet, or when the RPC's genesis hash belongs to another cluster (`src/lib/cluster.ts`, tested). Wallets don't expose their selected network over the Wallet Standard, so the wallet side is a reminder in the connect dialog; a wrong-network wallet will surface as a failed transaction in phase 6. The badge sits on `/mock` until the app shell (4.1).
- Env changes need a dev server restart (Next picked up a new `.env.local` but not its deletion).
- **3.3** done: `Faucet` (in the wallet's account dialog) shows the wallet's SOL and test-USDC balances. Devnet's RPC airdrop is closed (410, "Request test SOL at https://faucet.solana.com"), so on devnet "Get devnet SOL" copies the address and opens the web faucet, and the balance refreshes on return; localnet airdrops directly. Test USDC: `MockClient.requestTestTokens` credits 10,000 mock USDC. **Open for checkpoint B:** live test USDC needs the backend's test mint and a way to mint it (a faucet script, endpoint or mint authority); ask the backend at checkpoint B.
- **4.1** done: app pages live in the `src/app/(app)/` route group, whose layout wraps them in `AppShell` (`src/components/shell/`) and one `ToastProvider`. Desktop (lg+): `w-sidebar` sidebar with `Logo`, `SideNav` (groups in `nav-items.ts`) and `DemoControls` (mock only: acting-as select, clock +1 h / +6 h, reset); top bar with `NetworkBadge` and `WalletButton`. Below lg: top bar with a menu button that opens the same nav, badges and demo controls. Pages start with `PageHeader`. `/dashboard`, `/withdraw`, `/holds`, `/rules`, `/activity`, `/register` are `PlannedScreen` placeholders until their steps; `/mock` moved into the group. `/` (landing, 4.2) and `/components` stay outside the shell.
- Next step: **4.2**, landing page with Connect wallet and Open demo (replaces the setup-check page at `/`).

## The checklist

Tracked in the build checklist sheet: https://claude.ai/artifact/JrwuuXC69RDgnQCsV6YdYN (tabs: Checklist, How we build, Checkpoints). If you can't edit the sheet, tell the human which step to tick, and keep the status column below up to date in this file.

The checklist was first written when the product was imagined as a vault that holds funds. The real backend is a gate (see above). Step numbers and order stay; where a step's wording assumes the vault model, follow the **Contract note**.

| Step | Status | Task                                                                                     | Needs first   | Done when                                                                      | Priority |
| ---- | ------ | ---------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ | -------- |
| 0.1  | ✅     | Create the Next.js app (App Router, TypeScript) with pnpm                                |               | `pnpm dev` shows the starter page                                              | Must     |
| 0.2  | ✅     | ESLint, Prettier and the folders `app`, `components`, `lib`, `hooks`                     | 0.1           | Lint passes and the folders are committed                                      | Must     |
| 0.3  | ✅     | Env config: RPC URL, program IDs, USDC mint, data mode, monitor URL                      | 0.1           | `.env.example` committed and the app reads it                                  | Must     |
| 0.4  | ✅     | Push to a public GitHub repo                                                             | 0.1           | The repo link opens for anyone                                                 | Must     |
| 1.1  | ✅     | Review the installed design skills and pick a direction: colour, type, layout            | 0.1           | The human approves the direction                                               | Must     |
| 1.2  | ✅     | Turn the direction into tokens (colours, type scale, spacing), light and dark            | 1.1           | One tokens file; no colours defined anywhere else                              | Must     |
| 1.3  | ✅     | Base components: button, input, panel, badge, dialog, toast, countdown, amount           | 1.2           | A components page shows each in light and dark                                 | Must     |
| 2.1  | ✅     | TypeScript types for the program's accounts and events                                   | 0.3           | Types cover every account and event                                            | Must     |
| 2.2  | ✅     | One client interface for every read and write                                            | 2.1           | The interface lists every instruction and read                                 | Must     |
| 2.3  | ✅     | Mock client with in-memory state and a simulated clock                                   | 2.2           | Every interface method works in mock mode                                      | Must     |
| 2.4  | ✅     | Data hooks                                                                               | 2.3           | Hooks return mock data and refresh after each write                            | Must     |
| 3.1  | ✅     | Wallet connection (Phantom, Solflare, Backpack)                                          | 0.1           | Connect and disconnect work on devnet                                          | Must     |
| 3.2  | ✅     | Devnet badge and wrong-network warning                                                   | 3.1           | Badge shows; warning appears on mainnet                                        | Must     |
| 3.3  | ✅     | Faucet helper for devnet SOL and test USDC                                               | 3.1           | A first-time judge can fund a wallet from the app                              | Must     |
| 4.1  | ✅     | App shell: header, navigation, wallet button, network badge                              | 1.3, 3.2      | Shell renders on phone and desktop                                             | Must     |
| 4.2  |        | Landing page with Connect wallet and Open demo                                           | 4.1           | Explains Breakglass in one line; both buttons work                             | Must     |
| 4.3  |        | Create vault flow: form, review, confirm                                                 | 2.4, 4.1      | Works in mock mode                                                             | Must     |
| 4.4  |        | Vault dashboard                                                                          | 2.4, 4.1      | Figures match mock state and update after each action                          | Must     |
| 4.5  |        | Withdraw and deposit forms                                                               | 4.4           | Under the limit is allowed; over it is held                                    | Must     |
| 4.6  |        | Waiting room: held withdrawals with countdowns and risk flags                            | 4.4           | Guardian and admin actions work in mock mode                                   | Must     |
| 4.7  |        | Rules panel                                                                              | 4.4           | Changes wait out the timelock in mock mode                                     | Must     |
| 4.8  |        | Activity feed                                                                            | 4.4           | Every action appears with its time and actor                                   | Must     |
| 4.9  |        | Role awareness: show or disable each action and say why                                  | 4.5, 4.6, 4.7 | Each role sees only what it may do                                             | Must     |
| 4.10 |        | "My vaults" list                                                                         | 4.4           | Lists what this wallet administers or guards                                   | Later    |
| 5.1  |        | Confirm dialog that says what a transaction will do before signing                       | 4.5           | Every write shows a plain-language summary first                               | Must     |
| 5.2  |        | Pending, confirmed and failed states with explorer links                                 | 5.1           | Each write shows its state and a link                                          | Must     |
| 5.3  |        | Loading, empty and error states for every panel                                          | 4.9           | No panel is ever blank or stuck                                                | Must     |
| A    |        | **Checkpoint A:** program IDL, generated types, errors and events                        |               | The human confirms the IDL in `clients/ts/idl` covers the instructions we need | Must     |
| 5.4  |        | Map program errors to readable messages                                                  | A             | Every program error has a message                                              | Must     |
| B    |        | **Checkpoint B:** devnet program ID, test token mint, demo protocol config               |               | The human has shared the addresses                                             | Must     |
| 6.1  |        | TypeScript client from the IDL; devnet reads                                             | A, B          | The dashboard reads a real devnet config                                       | Must     |
| 6.2  |        | Devnet writes, one per instruction                                                       | 6.1           | Each instruction succeeds on devnet                                            | Must     |
| 6.3  |        | Live updates (account subscriptions or monitor `/stream`)                                | 6.1           | The dashboard updates without a refresh                                        | Must     |
| 6.4  |        | Switch to live mode and test every flow end to end                                       | 6.2, 6.3      | Every flow passes on devnet with a fresh wallet                                | Must     |
| C    |        | **Checkpoint C:** monitor API, guardian bot and demo/attack scripts, and how to run them |               | The human has shared the commands or URLs                                      | Must     |
| 7.1  |        | Attack scenario panel                                                                    | C, 6.4        | One click runs the attack story live on devnet                                 | Must     |
| 7.2  |        | Demo protocol with short delays (minutes, not hours)                                     | B             | A hold unlocks during the video                                                | Must     |
| 7.3  |        | Guardian view with AI explanations                                                       | C             | Each flagged item shows a plain-English reason                                 | Later    |
| 8.1  |        | Phone and desktop pass                                                                   | 6.4           | No sideways scroll at 360px; layout holds at 720px and 1280px                  | Must     |
| 8.2  |        | Accessibility pass: keyboard, focus, contrast                                            | 8.1           | Every action works by keyboard with visible focus                              | Must     |
| 8.3  |        | Deploy to Vercel                                                                         | 6.4           | The live link works with a fresh wallet                                        | Must     |
| 8.4  |        | Frontend section of the README with screenshots                                          | 8.3           | README has setup steps and the live link                                       | Must     |
| 8.5  |        | Record the demo video (under 3 minutes)                                                  | 7.1, 8.3      | Video uploaded and linked in the README                                        | Must     |

### Contract notes (vault wording → real backend)

- **2.1 Types:** mirror FRONTEND.md section 3: `ProtocolConfig`, `PausePolicy`, `PauseState`/`ScopePause`, `GuardianLedger`, `FlowLimiter`, `PendingWithdrawal`, `PendingConfig`; plus every event in section 6 and the monitor types in section 7 (`Incident`, `Event`, `Hold`, `Alert`).
- **2.2 Client interface:** reads for config, pause state, limiters, holds, pending changes, guardian ledgers, incidents. Writes: `initialize_config`, `pause`, `renew_pause`, `unpause`, `remove_guardian`, `init_flow_limiter`, `freeze_held`, `reject_held`, `claim_held` (through the protocol), `propose_config`, `execute_config`, `veto_config`, `cancel_config`, `release_held`, plus the test_vault's own deposit and withdraw.
- **2.3 Mock clock:** the mock must reproduce the gate's rules (window buckets, cap with bps of vault, threshold → hold, auto-trip, guardian cooldown and budget, timelock), so the demo behaves like the program.
- **4.3 "Create vault"** = register a protocol: `initialize_config` (protected program, guardians, unpausable scopes, timelock), then `init_flow_limiter` per mint.
- **4.4 "Vault dashboard"** = protocol dashboard: active pauses per scope with kind and time left, each mint's window usage against its effective cap, open holds, pending changes, guardian budget left, open incidents.
- **4.5 "Withdraw and deposit"** = deposit and withdraw on the protected protocol (test_vault); show the gate's answer: Allow (sent), Hold (held until `releaseAt`), Deny (scope paused).
- **4.6 "Waiting room"** = held withdrawals (`PendingWithdrawal`): status queued, frozen, released, rejected, claimed; guardian freeze, admin reject, user claim after `releaseAt`, release through the timelock. Risk flags come from the monitor (fresh address, velocity) once it exists; until then, rule-based in mock.
- **4.7 "Rules panel"** = two parts: pause controls (pause, renew, unpause by scope, within guardian limits) and config changes (propose, veto, cancel, execute after `executableAt`).
- **4.8 "Activity feed"** = Breakglass events (decoded via the client) or monitor `GET /events`, with incidents from `GET /incidents`.
- **4.9 Roles** = admin, guardian, user, anyone (see the roles table).
- **Checkpoint A** is partly met already: the backend branch commits the generated IDL in `clients/ts/idl/`. Each instruction becomes usable as its backend phase lands (P1 pauses, P2 limiter and holds, P4 timelocks).
- **Checkpoint C** is the monitor HTTP API (backend phase 5, extended in 6) and the `scripts/demo-*.ts` / attack scripts.
