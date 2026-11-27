# Breakglass backend spec and architecture

Source: the "Breakglass backend spec and architecture" doc (Nov 26, 2026). This file is the repo copy that Claude Code builds against. If the two disagree, ask the human which one wins.

## Overview

Breakglass makes every outflow from a protected Solana program pass through an on-chain gate. The gate can allow the outflow, hold it, or block it, and every hold or block is public before any money leaves.

An independent guardian can pause specific operations for a limited time. No Breakglass role can ever:
- move user funds
- upgrade the program
- change protocol ownership

**Core guarantee:**
- An attacker can move at most one window's outflow cap before the gate trips by itself.
- Any single withdrawal above the large-withdrawal threshold waits out a public hold, during which admins are paged.

Both limits are enforced on-chain, so they hold even if every off-chain monitor is down. Zero-loss mode (below) aims to cut the attacker's take to zero.

**Goals**
- Contain an exploit to a bounded, known loss (the window cap), or zero in zero-loss mode.
- Alert admins within seconds of any suspicious outflow, config change or pause.
- Integrate into an existing Anchor program with one macro or helper call per protected instruction.
- Keep the guardian's power narrow, time-limited, and unable to touch funds.

**Non-goals**
- Frontend or dashboard UI.
- Protecting against a compromised program upgrade authority. By default Breakglass only alerts on upgrades. The optional upgrade timelock vault can delay and veto them.
- Recovering stolen funds once they have left.

## Roles and permissions

| Role | Held by | Can do | Can never do |
| --- | --- | --- | --- |
| Admin | Protocol's multisig (e.g. Squads vault, 3 of 5) | Propose config and limit changes (timelocked), unpause anything early, extend a pause past the guardian cap, add (timelocked) or remove (immediate) guardians, reject held withdrawals, release them through the timelock | Move user funds through Breakglass, skip the timelock |
| Guardian | Independent party or security firm, plus its hot-key bot | Pause a scope up to the max duration, renew within the cap, lift its own pause, freeze a queued withdrawal, veto a pending config change or upgrade | Unpause an auto-trip or admin pause, change config, move funds, upgrade anything |
| Breakglass program | Immutable or timelocked-upgrade program | Record outflows, auto-trip a scope when a cap is hit, queue withdrawals, emit events | Hold token authority over any vault |
| Protected program | The integrating protocol | Call the gate on every protected instruction, keep funds in its own vaults | Bypass the gate on a protected instruction (fails closed) |
| Watchers | Off-chain monitors | Read chain state, raise alerts, drive the guardian bot | Sign anything except through the guardian bot's key |

## System architecture

The system has two halves that fail independently:
- an on-chain gate that bounds losses with no off-chain help
- an off-chain backend that turns every gate event into a page within seconds

**On-chain**
- `breakglass` program: owns the config, pause, limiter and pending-withdrawal accounts, and emits every decision as an event.
- `breakglass-sdk` crate: the CPI helper (later the `#[breakglass::protected]` macro) that protocols add to their instructions.
- The protocol's own program and vaults: funds leave only through the protocol's own transfer, after the gate says Allow.

**Off-chain**
- Ingestors: 2+ independent RPC/WebSocket (later Geyser) streams, watching the Breakglass program, the protected program, and the vault token accounts. Deduped by signature.
- Detectors: rules plus statistical baselines. Each produces signals with a severity.
- Alert router: fans out to paging, chat and webhooks, and escalates until someone acknowledges.
- Guardian bot: holds only the guardian key and pauses or freezes automatically, within the on-chain limits.
- Store and admin API: Postgres for incidents, config mirrors and acks, plus a time-series table for outflow baselines.

## On-chain program design

The program is a gate and a ledger, never a custodian. It returns Allow, Hold or Deny, and the protocol does its own transfer.

### Accounts (PDAs)

| Account | Seeds | Key fields |
| --- | --- | --- |
| `ProtocolConfig` | `["config", protected_program_id]` | admin, guardians (≤5), pause policy (max duration, renew cap, cooldown, monthly budget), unpausable scope mask, timelock seconds, version |
| `PauseState` | `["pause", config]` | paused scope bitmask (u64), per-scope `paused_until`, `paused_by`, pause kind (guardian, auto-trip, admin), renew count, reason code |
| `FlowLimiter` | `["flow", config, mint]` | window length, cap (absolute + bps of vault balance), 12 sub-buckets, large-withdrawal threshold, hold seconds, auto-trip seconds, instant allowance, screen seconds |
| `PendingWithdrawal` | `["hold", config, owner, nonce]` | owner, mint, amount, `release_at`, status (queued, frozen, released, rejected, claimed) |
| `PendingConfig` | `["cfgchg", config, id]` | action, `executable_at`, vetoed flag |
| `GuardianLedger` | `["gledger", config, guardian]` | pause-seconds used in the current 30-day period, period start, last pause end (cooldown) |

There is one limiter per mint, so write-lock contention stays per asset.

### Instructions

| Instruction | Signer | Effect |
| --- | --- | --- |
| `initialize_config` | Admin | Registers a protected program with policy defaults |
| `check_outflow(scope, mint, amount, owner)` | Protected program (CPI, PDA signer) | Deny if the scope is paused. Hold if amount ≥ threshold, or the window would overflow, or the amount is over the instant allowance. Else Allow and add the amount to the window. Auto-trips the scope when the cap is reached. |
| `check_scope(scope)` | Protected program | Deny if paused. No write lock. |
| `claim_held(hold)` | Protected program on the user's behalf | Only after `release_at`, if not frozen and the scope is not paused |
| `pause(scopes, duration, reason)` | Guardian (or admin) | Bounded by max duration, cooldown and monthly budget |
| `renew_pause(scopes)` | Guardian | Up to the renew cap; past it, admin only |
| `unpause(scopes)` | Admin, or the guardian for its own pause | Auto-trips need the admin |
| `freeze_held` / `reject_held` / `release_held` | Guardian freezes; admin rejects immediately; release goes through the timelock | Reject returns the claim to the user's position inside the protocol |
| `propose_config` / `execute_config` / `veto_config` / `cancel_config` | Admin / anyone after the timelock / guardian / admin | Loosening changes wait out the timelock (24 to 48h, default 48h). Tightening applies at once. |
| `remove_guardian` | Admin | Immediate |

Every instruction emits an Anchor CPI event (`emit_cpi!`).

### Integration in the protocol

```rust
#[breakglass::protected(scope = WITHDRAW, outflow(mint = vault.mint, amount = amount, owner = user))]
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    // Allow -> body runs and transfers.
    // Hold  -> creates PendingWithdrawal, returns Ok without transferring.
    // Deny  -> returns BreakglassError::ScopePaused.
    token::transfer(ctx.accounts.transfer_ctx(), amount)?;
    Ok(())
}
```

The Breakglass accounts are checked for owner and seeds, so a caller can't pass a fake `PauseState`. If an account is missing or wrong, the instruction fails, which means the gate **fails closed**.

### Outflow limiter

- The window is 12 sub-buckets (e.g. 5 minutes each for a 1h window). Buckets older than the window are zeroed before adding the new amount.
- Cap = min(absolute cap, bps × current vault balance), so the cap shrinks as the vault drains.
- Calls in the same transaction and the same slot all count. Splitting a withdrawal or using a flash loan does not escape the cap.
- A cap breach returns Hold, not Deny, and auto-pauses the scope (default 1h).

## Step by step: what the breaker does

**A. Normal withdrawal.**
1. The macro checks that the scope is not paused.
2. `check_outflow` returns Allow.
3. The protocol transfers the funds.
4. `OutflowRecorded` is emitted and the monitor indexes it.

**B. Large withdrawal.**
1. `check_outflow` returns Hold.
2. A `PendingWithdrawal` is created with `release_at = now + 6h`. The funds stay in the vault.
3. `LargeWithdrawalQueued` is emitted and admins and the guardian are paged.
4. If the withdrawal is legitimate, the user claims it after `release_at`. If it is malicious, the guardian freezes it and the admin rejects it.

**C. Exploit in chunks.**
1. Each withdrawal counts toward the window. The monitor alerts at 50% and 80% of the cap.
2. The call that would cross the cap returns Hold and auto-trips the scope.
3. `LimitTripped` and `Paused` are emitted and a Critical page goes out.
4. The guardian bot may pause even earlier on detector signals.
5. The maximum loss is one window's cap.

**D. Bypass through an unprotected path.**
1. There is no Breakglass event, but the vault balance drops.
2. The balance-delta detector raises a Critical alert.
3. The bot pauses all protected scopes.

**E. Attacker holds the admin key.**
1. Any loosening change is queued behind the timelock and `ConfigChangeProposed` is emitted.
2. A page goes out and the guardian vetoes the change.

## Zero-loss mode

The off-chain monitor can't block the first withdrawal, because Solana has no public mempool. The monitor only sees a transaction after it lands. Blocking must happen on-chain, before the transfer.

1. **In-transaction invariants.** The SDK snapshots state before the instruction and asserts invariants after it. Example invariants:
   - the vault balance drops only by the amount owed to this user
   - total assets ≥ liabilities
   - the share price never falls
   - no withdrawal is larger than the user's recorded position

   On failure the transaction reverts.
2. **Screen every withdrawal.** Set the instant allowance to 0 (or small). Every withdrawal becomes a `PendingWithdrawal` with a short `screen_secs` delay (2 to 10 min). The risk engine checks it. Clean withdrawals release automatically. Flagged ones are frozen by the guardian bot.
3. **Risk co-signer (optional).** Instant withdrawals require a short-lived Ed25519 attestation from the risk engine. If the co-signer is down, withdrawals fall back to path 2.

What zero-loss mode still can't stop:
- unprotected instructions, which only get alerts
- a compromised upgrade authority, unless the upgrade vault is used
- a novel exploit that passes the invariants and screening, which the window cap backstops
- a compromised co-signer key combined with a protocol bug

**Recommendation:**
- invariants are mandatory
- screen-all is the default for vaults and treasuries
- the co-signer is optional
- the window cap and alerts stay on in every mode

## Monitoring and alerting backend

**Ingestion**
- 2+ RPC providers (plus Geyser later), in two regions.
- Deduplicated by signature.
- Subscriptions:
  - Breakglass events
  - the protected program's transactions
  - vault token accounts
  - the ProgramData accounts (to catch upgrades)
  - the admin multisig
- Alerts fire at `processed` commitment. State updates at `confirmed`.
- Ingestors send heartbeats. A gap over 30s raises an alert.

**Detectors**

| Detector | Fires when | Severity |
| --- | --- | --- |
| Pause / trip / unpause | `Paused`, `LimitTripped`, `Unpaused` | Critical (trip), High |
| Large withdrawal | `LargeWithdrawalQueued` | High |
| Window usage | 50% / 80% of cap | Warning / High |
| Balance delta | Vault drop > recorded outflows | Critical |
| Velocity baseline | Hourly outflow > 4σ above its 30-day baseline | High |
| Fresh address | Withdrawals to wallets funded in the last 24h, or from a mixer or bridge | High |
| Config change | `ConfigChangeProposed`, guardian or admin change | High |
| Program upgrade | Upgrade of the protected program or Breakglass | Critical |
| Oracle deviation | Price feed deviates from a second source | High |
| Watcher liveness | Missed heartbeat | High |

**Alert fan-out**
- Channels: PagerDuty or Opsgenie, Telegram, Discord, Slack, SMS, email, and signed webhooks.
- Routing: Critical pages every admin signer and the guardian. High pages on-call. Warning goes to chat only.
- Escalation: an unacked Critical re-pages every 2 min and escalates after 5 min.
- Content: every alert carries the transaction link, the amount and share of TVL, the scope, the gate's decision, and the allowed actions.
- Dedup: one incident per root cause.

**Guardian bot**
- Holds only the guardian key, in a KMS or HSM in production.
- Pauses on Critical signals from 2 independent detectors, or on balance-delta alone.
- Freezes withdrawals flagged by the fresh-address or velocity detectors.
- Bounded by the on-chain griefing limits.

**Store and admin API**
- Postgres tables: protocols, config mirrors, events, incidents, alerts, acks, actions, and a time-series table for outflow.
- REST API for incidents, acks, holds and pending changes. The API builds multisig transactions but never signs them.

## Open design points (defaults)

| Question | Default |
| --- | --- |
| Pause scope | Up to 64 named scopes as a bitmask. Exit-safety scopes (repay, add collateral, close) are unpausable. |
| Auto-expiry | Guardian pause max 24h. Auto-trip pause 1h. Every pause has `paused_until`. |
| Renewal | The guardian can renew 2 times (72h total). After that, only the admin can extend. |
| Early unpause | The admin can unpause anything. The guardian can lift only its own pause. Auto-trips need the admin. |
| Griefing limits | 6h cooldown, 96 pause-hours per 30 days per guardian, immediate removal by the admin, optional bond. |
| Hold | 6h for large withdrawals. The threshold is an amount plus a share of TVL (e.g. 2%). |
| Timelock | 24 to 48h (default 48h) for any action that loosens protection or moves funds. An alert fires when the action is queued, and the guardian can veto. Tightening applies at once. |
| Fail mode | Fail closed. |

**Recovery flow**
1. The breaker trips and alerts go out.
2. The incident lead acknowledges and extends the pause through the multisig if needed.
3. Suspicious holds are frozen and the root cause is found.
4. The protocol patches through its own upgrade process.
5. Limits are optionally tightened for the restart.
6. Scopes are unpaused one by one, exit-safety scopes first.
7. Frozen holds are released or rejected.
8. After 24h quiet, normal limits are restored (timelocked) and a post-mortem is written.

## Upgrade timelock vault (optional)

The protocol hands its upgrade authority to an `UpgradeVault` PDA. The flow:
1. The admin queues an upgrade with the buffer and its code hash. The default delay is 48h.
2. An alert fires.
3. The guardian can veto during the delay.
4. After the delay, anyone can execute. The vault re-hashes the buffer and calls the BPF upgradeable loader.

**Risks:**
- A bug in the vault can brick the protocol or allow an upgrade with no delay. The vault must be minimal and audited multiple times.
- It needs a timelocked way to hand the authority back.
- Emergency hotfixes also have to wait out the delay, so pauses must hold the line in the meantime.

## Relationship to Squads

- Breakglass works alongside Squads; it is not built on top of it.
- **Recommended setup:** the Breakglass admin and the upgrade-vault proposer are a Squads multisig.
- **Breakglass adds** the gate, pauses, holds, the guardian veto and alerting.
- **Don't rebuild Squads' timelock.** The Breakglass timelock covers only Breakglass actions.
- The monitor also watches the Squads multisig for proposals that touch the protocol.

## Threat model

| Threat | Mitigation | Residual |
| --- | --- | --- |
| Exploit through a protected instruction | Cap, auto-trip, holds, invariants, screening, bot | ≤ one window's cap; zero in zero-loss mode for covered bug classes |
| Many small withdrawals or sybil wallets | The cap is global per mint, and same-transaction and same-slot calls all count | Same as above |
| Flash-loan drain in one transaction | Every CPI hits the same limiter | Same as above |
| Unprotected instruction | Balance-delta detector, onboarding coverage audit | Loss until a pause; that path stays open |
| Upgrade authority compromised | Upgrade detector, optional upgrade vault | Only alerts without the vault |
| Guardian key compromised | No fund, config or trip-unpause power; duration, cooldown and budget caps; instant removal | Up to 72h of pauses |
| Admin multisig compromised | Timelocked, public, guardian-vetoable | Can unpause during an incident, so the guardian must stay independent |
| Monitor down or RPC censored | Redundancy, heartbeats, on-chain limits | Slower response; loss still capped |
| Breakglass bug | Small, audited, fuzzed, fail closed | A bug blocks withdrawals instead of leaking funds |
| Cap filled to grief users | A breach returns Hold, and the attacker has to withdraw real funds | Short delays |
| Write-lock contention | One limiter per mint; read-only `check_scope` | Per-mint throughput; benchmark it |

**Trust assumptions:**
- The guardian and the admin are different parties.
- At least one watcher and one alert channel work.
- Every instruction that moves vault funds is protected.

## Testing and attack simulation

**Environment**
- localnet (`solana-test-validator`, `anchor test`), then devnet.
- A test-vault with a planted bug (feature `planted-bug`).
- Per-run attacker, guardian and Squads admin keys.

**Attack scripts**

| Script | Attack | Pass criteria |
| --- | --- | --- |
| Big drain | One huge withdrawal through the bug | Reverted by invariant, or held and frozen; zero loss; Critical alert |
| Many small | Hundreds of sub-threshold withdrawals, from many wallets and inside single transactions | Frozen, or the cap trips; ≤ cap (zero in zero-loss mode); alerts at 50%, 80%, trip |
| Bypass the check | Omit the Breakglass accounts, pass fake ones, or use an unprotected instruction | Fails; unprotected path triggers balance-delta and the bot pauses |
| Rogue guardian | Spam pauses, over-renew, unpause a trip, change config, move funds | All blocked; downtime within limits; the admin removes the guardian |
| Stolen admin key | Raise limits, add a guardian, release frozen funds, queue an upgrade | All timelocked, alerted and vetoable |
| Monitor outage | Kill the ingestors, then drain | On-chain gate holds; liveness alert |

## Open questions

- Should Token-2022 transfer hooks be supported as an extra integration path?
- Who is the first guardian: a Breakglass service, a third-party firm, or the protocol's own separate team?
- Should the cap be USD-based across mints (needs an oracle), or per mint in v0?
- Should the Breakglass program be immutable after audit, or upgradeable behind a timelock?
- Which paging and chat tools should be the first channels?
