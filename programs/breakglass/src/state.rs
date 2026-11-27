//! Account layouts. See docs/SPEC.md "Accounts (PDAs)".
//! ProtocolConfig, PauseState, GuardianLedger (Phase 1), FlowLimiter and
//! PendingWithdrawal (Phase 2) are live. PendingConfig is wired up in Phase 4.

use anchor_lang::prelude::*;

use crate::constants::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct PausePolicy {
    pub max_guardian_pause_secs: i64,
    pub max_renewals: u8,
    pub cooldown_secs: i64,
    pub budget_secs_per_period: i64,
    pub budget_period_secs: i64,
    pub auto_trip_secs: i64,
}

impl Default for PausePolicy {
    fn default() -> Self {
        Self {
            max_guardian_pause_secs: DEFAULT_MAX_GUARDIAN_PAUSE_SECS,
            max_renewals: DEFAULT_MAX_RENEWALS,
            cooldown_secs: DEFAULT_COOLDOWN_SECS,
            budget_secs_per_period: DEFAULT_BUDGET_SECS_PER_PERIOD,
            budget_period_secs: DEFAULT_BUDGET_PERIOD_SECS,
            auto_trip_secs: DEFAULT_AUTO_TRIP_SECS,
        }
    }
}

/// PDA ["config", protected_program]
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub version: u8,
    pub bump: u8,
    pub protected_program: Pubkey,
    /// Usually a Squads multisig vault PDA.
    pub admin: Pubkey,
    #[max_len(MAX_GUARDIANS)]
    pub guardians: Vec<Pubkey>,
    /// Scopes that can never be paused (exit-safety paths such as repay).
    pub unpausable_mask: u64,
    pub policy: PausePolicy,
    pub timelock_secs: i64,
    pub next_change_id: u64,
}

impl ProtocolConfig {
    pub fn is_guardian(&self, key: &Pubkey) -> bool {
        self.guardians.iter().any(|g| g == key)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum PauseKind {
    Guardian,
    AutoTrip,
    Admin,
}

impl PauseKind {
    /// Code used in the `Paused.kind` event field.
    pub fn code(self) -> u8 {
        match self {
            PauseKind::Guardian => 0,
            PauseKind::AutoTrip => 1,
            PauseKind::Admin => 2,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct ScopePause {
    pub scope: u8,
    pub paused_until: i64,
    pub paused_by: Pubkey,
    pub kind: PauseKind,
    pub renewals: u8,
    pub reason: u16,
}

/// PDA ["pause", config]
#[account]
#[derive(InitSpace)]
pub struct PauseState {
    pub bump: u8,
    pub config: Pubkey,
    #[max_len(MAX_ACTIVE_PAUSES)]
    pub active: Vec<ScopePause>,
}

impl PauseState {
    /// A pause past its `paused_until` counts as not paused (lazy expiry).
    pub fn is_paused(&self, scope: u8, now: i64) -> bool {
        self.active
            .iter()
            .any(|p| p.scope == scope && p.paused_until > now)
    }
}

/// PDA ["flow", config, mint]. One per mint, so write locks stay per asset.
/// Window math lives in `limiter.rs`.
#[account]
#[derive(InitSpace)]
pub struct FlowLimiter {
    pub bump: u8,
    pub config: Pubkey,
    pub mint: Pubkey,
    /// The protocol's vault token account for `mint`. Its balance sizes the bps cap.
    pub vault: Pubkey,
    /// The outflow scope this limiter gates (and auto-trips on a cap breach).
    pub scope: u8,
    pub window_secs: i64,
    pub cap_absolute: u64,
    /// 0 = no balance-based cap.
    pub cap_bps_of_vault: u16,
    /// Ring of outflow sums; bucket width = ceil(window_secs / 11), so the 12
    /// buckets always cover at least `window_secs` (never under-counts).
    pub buckets: [u64; LIMITER_BUCKETS],
    /// Start time of the newest bucket.
    pub bucket_start: i64,
    pub large_threshold: u64,
    /// 0 = threshold is `large_threshold` only; else min(large_threshold, bps x balance).
    pub large_threshold_bps: u16,
    pub hold_secs: i64,
    pub auto_trip_secs: i64,
    /// Zero-loss mode (Phase 3): amount per call that may skip screening (0 = screen everything).
    pub instant_allowance: u64,
    pub screen_secs: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum HoldStatus {
    Queued,
    Frozen,
    Released,
    Rejected,
    Claimed,
}

/// Why a withdrawal was held.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum HoldKind {
    /// amount >= large-withdrawal threshold
    Large,
    /// would have crossed the window cap (the scope was auto-tripped)
    Limit,
    /// zero-loss screening (Phase 3)
    Screen,
}

/// PDA ["hold", config, owner, nonce]. Created by `check_outflow` on Hold.
#[account]
#[derive(InitSpace)]
pub struct PendingWithdrawal {
    pub bump: u8,
    pub config: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub nonce: u64,
    pub created_at: i64,
    pub release_at: i64,
    pub status: HoldStatus,
    pub scope: u8,
    pub kind: HoldKind,
}

/// What `check_outflow` / `claim_held` return (Anchor return data).
/// Deny never comes back as a value: Breakglass fails with `ScopePaused`
/// instead, so the error is attributed to Breakglass. The variant stays for SDK
/// callers that want an exhaustive match.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Hold,
    Deny,
}

/// PDA ["gledger", config, guardian]. Created on the signer's first `pause` or `renew_pause`.
#[account]
#[derive(InitSpace)]
pub struct GuardianLedger {
    pub bump: u8,
    pub config: Pubkey,
    pub guardian: Pubkey,
    pub period_start: i64,
    pub pause_secs_used: i64,
    pub last_pause_end: i64,
}

/// PDA ["cfgchg", config, id]. Wired up in Phase 4; the action enum lands then.
#[account]
#[derive(InitSpace)]
pub struct PendingConfig {
    pub bump: u8,
    pub config: Pubkey,
    pub id: u64,
    pub action_kind: u8,
    #[max_len(256)]
    pub action_data: Vec<u8>,
    pub proposed_at: i64,
    pub executable_at: i64,
    pub vetoed: bool,
    pub executed: bool,
}
