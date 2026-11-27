//! Normalized events flowing through the pipeline: ingestors -> detectors -> router -> sinks.

use serde::Serialize;

/// What the ingestors produce. Phase 5 decodes these from Anchor CPI events
/// (see programs/breakglass/src/events.rs) and from vault account updates.
#[derive(Debug, Clone, PartialEq)]
pub enum ChainEvent {
    Paused { scopes_mask: u64, paused_until: i64, by: String, kind: u8 },
    Unpaused { scopes_mask: u64, by: String },
    LimitTripped { mint: String, scope: u8, window_total: u64, window_cap: u64 },
    LargeWithdrawalQueued { hold: String, owner: String, amount: u64, release_at: i64 },
    OutflowRecorded { mint: String, owner: String, amount: u64, window_total: u64, window_cap: u64 },
    ConfigChangeProposed { change: String, action_kind: u8, executable_at: i64 },
    VaultBalanceChanged { vault: String, before: u64, after: u64, recorded_outflow: u64 },
    Heartbeat { source: String, unix_ts: i64 },
}

#[derive(Debug, Clone)]
pub struct Observed {
    pub signature: Option<String>,
    pub slot: u64,
    pub event: ChainEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Severity {
    Warning,
    High,
    Critical,
}

/// What a detector emits. The router turns signals into incidents and alerts.
#[derive(Debug, Clone, Serialize)]
pub struct Signal {
    pub detector: &'static str,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    pub signature: Option<String>,
    /// Signals with the same key fold into one incident.
    pub dedupe_key: String,
}
