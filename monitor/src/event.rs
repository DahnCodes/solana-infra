//! Normalized events flowing through the pipeline: ingestors -> detectors -> router -> sinks.

use serde::Serialize;

use crate::decode::BgEvent;

/// What detectors see.
#[derive(Debug, Clone, PartialEq)]
pub enum ChainEvent {
    /// A Breakglass event (decoded from an `emit_cpi!` inner instruction).
    Breakglass(BgEvent),
    /// A vault token account's balance (on change, and once at startup).
    VaultBalance {
        vault: String,
        mint: String,
        amount: u64,
    },
    /// A program's ProgramData account (on change, and once at startup).
    /// `hash` covers the whole account: code, upgrade slot and upgrade authority.
    ProgramData { program: String, hash: String },
    /// An ingestor's websocket is alive (slot notifications).
    Heartbeat { source: String },
    /// Tokens moved into a watched vault, attributed to the owner of the
    /// token account they came from (from the transaction's token balances).
    Deposit {
        owner: String,
        mint: String,
        vault: String,
        amount: u64,
    },
    /// What the monitor knows about a wallet that just withdrew.
    /// `first_seen`: block time of its oldest transaction found (None: lookup failed).
    /// `flagged_funder`: a configured mixer/bridge address in that first transaction.
    WalletProfile {
        wallet: String,
        first_seen: Option<i64>,
        flagged_funder: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub struct Observed {
    /// Which ingestor saw it first, e.g. "rpc0".
    pub source: String,
    pub signature: Option<String>,
    pub slot: u64,
    /// Wall clock (unix seconds) when the monitor received it.
    pub received_at: i64,
    pub event: ChainEvent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warning,
    High,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Info => "info",
            Severity::Warning => "warning",
            Severity::High => "high",
            Severity::Critical => "critical",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "info" => Some(Severity::Info),
            "warning" => Some(Severity::Warning),
            "high" => Some(Severity::High),
            "critical" => Some(Severity::Critical),
            _ => None,
        }
    }
}

/// What a detector emits. The router turns signals into incidents and alerts.
#[derive(Debug, Clone, Serialize)]
pub struct Signal {
    pub detector: &'static str,
    pub severity: Severity,
    pub title: String,
    pub detail: String,
    /// What the responders can do about it (spec: "the allowed actions").
    pub actions: String,
    pub signature: Option<String>,
    /// Signals with the same key fold into one incident (one per root cause).
    pub dedupe_key: String,
    /// What the signal is about, for the guardian bot (which hold to freeze).
    pub subject: Subject,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Subject {
    pub hold: Option<String>,
    pub owner: Option<String>,
    pub mint: Option<String>,
}

/// Unix seconds now.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// `pct` of `part` in `whole`, as a short string ("12.5%"), or "?" when unknown.
pub fn share(part: u64, whole: Option<u64>) -> String {
    match whole {
        Some(w) if w > 0 => format!("{:.1}%", part as f64 * 100.0 / w as f64),
        _ => "?".into(),
    }
}

/// RFC 3339 for a unix timestamp.
pub fn rfc3339(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| ts.to_string())
}
