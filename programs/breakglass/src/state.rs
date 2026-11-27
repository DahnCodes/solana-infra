//! Account layouts. See docs/SPEC.md "Accounts (PDAs)".
//! ProtocolConfig, PauseState and GuardianLedger are live (Phase 1). The rest
//! are defined now so the layout is reviewed early, and wired up in later phases.

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

/// PDA ["flow", config, mint]. Wired up in Phase 2.
#[account]
#[derive(InitSpace)]
pub struct FlowLimiter {
    pub bump: u8,
    pub config: Pubkey,
    pub mint: Pubkey,
    pub scope: u8,
    pub window_secs: i64,
    pub cap_absolute: u64,
    pub cap_bps_of_vault: u16,
    pub buckets: [u64; LIMITER_BUCKETS],
    pub bucket_start: i64,
    pub large_threshold: u64,
    pub hold_secs: i64,
    /// Zero-loss mode: amount per call that may skip screening (0 = screen everything).
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

/// PDA ["hold", config, owner, nonce]. Wired up in Phase 2.
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
