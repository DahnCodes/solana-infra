//! Every Breakglass decision is an event (emitted with `emit_cpi!`). The monitor
//! decodes these, so changing a field is a breaking change for monitor/.

use anchor_lang::prelude::*;

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub protected_program: Pubkey,
    pub admin: Pubkey,
    pub guardians: Vec<Pubkey>,
}

#[event]
pub struct Paused {
    pub config: Pubkey,
    pub scopes_mask: u64,
    pub paused_until: i64,
    pub by: Pubkey,
    pub kind: u8,
    pub reason: u16,
}

#[event]
pub struct PauseRenewed {
    pub config: Pubkey,
    pub scopes_mask: u64,
    pub paused_until: i64,
    pub by: Pubkey,
    pub renewals: u8,
}

#[event]
pub struct Unpaused {
    pub config: Pubkey,
    pub scopes_mask: u64,
    pub by: Pubkey,
}

#[event]
pub struct GuardianRemoved {
    pub config: Pubkey,
    pub guardian: Pubkey,
}

#[event]
pub struct OutflowRecorded {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub window_total: u64,
    pub window_cap: u64,
}

#[event]
pub struct LargeWithdrawalQueued {
    pub config: Pubkey,
    pub hold: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub release_at: i64,
}

#[event]
pub struct WithdrawalScreenQueued {
    pub config: Pubkey,
    pub hold: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub release_at: i64,
}

/// A withdrawal that would have crossed the window cap was held (and the scope
/// auto-tripped; `LimitTripped` and `Paused` are emitted with it).
#[event]
pub struct LimitHoldQueued {
    pub config: Pubkey,
    pub hold: Pubkey,
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub release_at: i64,
}

#[event]
pub struct LimitTripped {
    pub config: Pubkey,
    pub mint: Pubkey,
    pub scope: u8,
    pub window_total: u64,
    pub window_cap: u64,
    pub paused_until: i64,
}

#[event]
pub struct HoldFrozen {
    pub config: Pubkey,
    pub hold: Pubkey,
    pub by: Pubkey,
}

#[event]
pub struct HoldResolved {
    pub config: Pubkey,
    pub hold: Pubkey,
    /// 0 = claimed, 1 = released, 2 = rejected
    pub outcome: u8,
}

#[event]
pub struct ConfigChangeProposed {
    pub config: Pubkey,
    pub change: Pubkey,
    pub action_kind: u8,
    pub executable_at: i64,
}

#[event]
pub struct ConfigChangeExecuted {
    pub config: Pubkey,
    pub change: Pubkey,
}

#[event]
pub struct ConfigChangeCancelled {
    pub config: Pubkey,
    pub change: Pubkey,
}

/// The admin tightened a limiter immediately (no timelock needed).
#[event]
pub struct LimitsTightened {
    pub config: Pubkey,
    pub flow_limiter: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct ConfigChangeVetoed {
    pub config: Pubkey,
    pub change: Pubkey,
    pub by: Pubkey,
}
