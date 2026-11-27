//! Spec defaults (docs/SPEC.md, "Open design points"). Keep every tunable here.

pub const CONFIG_SEED: &[u8] = b"config";
pub const PAUSE_SEED: &[u8] = b"pause";
pub const FLOW_SEED: &[u8] = b"flow";
pub const HOLD_SEED: &[u8] = b"hold";
pub const CFGCHG_SEED: &[u8] = b"cfgchg";
pub const GLEDGER_SEED: &[u8] = b"gledger";
/// Seed of the PDA a protected program signs with when it CPIs `check_outflow`.
pub const GATE_SIGNER_SEED: &[u8] = b"breakglass-gate";

pub const HOUR: i64 = 3_600;
pub const DAY: i64 = 24 * HOUR;

pub const MAX_GUARDIANS: usize = 5;
/// Max simultaneously active scope pauses tracked in PauseState.
pub const MAX_ACTIVE_PAUSES: usize = 16;
pub const MAX_SCOPES: u8 = 64;

// Pause policy
pub const DEFAULT_MAX_GUARDIAN_PAUSE_SECS: i64 = 24 * HOUR;
pub const DEFAULT_MAX_RENEWALS: u8 = 2;
pub const DEFAULT_COOLDOWN_SECS: i64 = 6 * HOUR;
pub const DEFAULT_BUDGET_SECS_PER_PERIOD: i64 = 96 * HOUR;
pub const DEFAULT_BUDGET_PERIOD_SECS: i64 = 30 * DAY;
pub const DEFAULT_AUTO_TRIP_SECS: i64 = HOUR;

// Outflow limiter
pub const LIMITER_BUCKETS: usize = 12;
pub const DEFAULT_WINDOW_SECS: i64 = HOUR;
pub const DEFAULT_HOLD_SECS: i64 = 6 * HOUR;
pub const DEFAULT_SCREEN_SECS: i64 = 120;
pub const BPS_DENOMINATOR: u64 = 10_000;

// Timelock
pub const MIN_TIMELOCK_SECS: i64 = 24 * HOUR;
pub const MAX_TIMELOCK_SECS: i64 = 48 * HOUR;
pub const DEFAULT_TIMELOCK_SECS: i64 = 48 * HOUR;

/// Example scope ids. Each protocol maps its own instructions to scope ids (0..64).
pub mod scopes {
    pub const DEPOSIT: u8 = 0;
    pub const WITHDRAW: u8 = 1;
    pub const BORROW: u8 = 2;
    pub const REPAY: u8 = 3;
}

#[inline]
pub fn scope_bit(scope: u8) -> u64 {
    1u64 << scope
}
