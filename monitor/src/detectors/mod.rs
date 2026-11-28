//! Detectors: pure functions from an observed event (plus their own state) to
//! signals. No network I/O, so each one is unit-tested with fixtures.
//! Time-based checks (liveness, unexplained balance drops) run in `tick`.

use crate::decode::BgEvent;
use crate::event::{Observed, Signal};

/// A newly held withdrawal (any hold kind).
pub struct HoldRequest {
    pub hold: String,
    pub owner: String,
    pub mint: String,
    pub amount: u64,
}

pub fn hold_request(e: &BgEvent) -> Option<HoldRequest> {
    let (hold, owner, mint, amount) = match e {
        BgEvent::LargeWithdrawalQueued(x) => (x.hold, x.owner, x.mint, x.amount.0),
        BgEvent::WithdrawalScreenQueued(x) => (x.hold, x.owner, x.mint, x.amount.0),
        BgEvent::LimitHoldQueued(x) => (x.hold, x.owner, x.mint, x.amount.0),
        _ => return None,
    };
    Some(HoldRequest {
        hold: hold.to_string(),
        owner: owner.to_string(),
        mint: mint.to_string(),
        amount,
    })
}

mod balance_delta;
mod blocked_exploit;
mod config_change;
mod deposit_history;
mod fresh_address;
mod large_withdrawal;
mod liveness;
mod pause_trip;
mod program_upgrade;
mod velocity_baseline;
mod window_usage;

pub use balance_delta::BalanceDelta;
pub use blocked_exploit::BlockedExploit;
pub use config_change::ConfigChange;
pub use deposit_history::{Books, DepositHistory};
pub use fresh_address::FreshAddress;
pub use large_withdrawal::LargeWithdrawal;
pub use liveness::Liveness;
pub use pause_trip::PauseTrip;
pub use program_upgrade::ProgramUpgrade;
pub use velocity_baseline::VelocityBaseline;
pub use window_usage::WindowUsage;

pub trait Detector: Send {
    fn name(&self) -> &'static str;
    fn observe(&mut self, ev: &Observed) -> Vec<Signal>;
    /// Called about once a second with the wall clock (unix seconds).
    fn tick(&mut self, _now: i64) -> Vec<Signal> {
        vec![]
    }
}

/// History loaded from the store at startup.
#[derive(Default)]
pub struct Seeds {
    /// When the monitor's records for this protocol begin (unix secs).
    pub history_start: i64,
    /// (mint, hour start, requested outflow)
    pub velocity: Vec<(String, i64, u128)>,
    /// (owner, mint, books)
    pub books: Vec<(String, String, Books)>,
    /// (hold, owner, mint, amount) still pending
    pub holds: Vec<(String, String, String, u128)>,
}

pub fn default_set(
    cfg: &crate::config::DetectorConfig,
    sources: Vec<String>,
    program_names: Vec<(String, String)>,
    now: i64,
    seeds: Seeds,
) -> Vec<Box<dyn Detector>> {
    let mut velocity = VelocityBaseline::new(cfg.velocity_sigma, cfg.velocity_min_hours);
    velocity.seed(seeds.velocity);
    let mut deposits = DepositHistory::new(seeds.history_start);
    deposits.seed(seeds.books, seeds.holds);
    vec![
        Box::new(PauseTrip),
        Box::new(BlockedExploit),
        Box::new(LargeWithdrawal::default()),
        Box::new(WindowUsage::new(
            cfg.window_warning_pct,
            cfg.window_high_pct,
        )),
        Box::new(BalanceDelta::new(
            cfg.balance_tolerance,
            cfg.balance_grace_secs,
        )),
        Box::new(ConfigChange::default()),
        Box::new(ProgramUpgrade::new(program_names)),
        Box::new(Liveness::new(
            sources,
            cfg.heartbeat_timeout_secs as i64,
            now,
        )),
        Box::new(FreshAddress::new(cfg.fresh_address_max_age_secs)),
        Box::new(deposits),
        Box::new(velocity),
    ]
}

#[cfg(test)]
pub(crate) mod fixtures {
    use crate::decode::{BgEvent, Pk, I64, U64};
    use crate::event::{ChainEvent, Observed};

    pub fn pk(i: u8) -> Pk {
        Pk([i; 32])
    }
    pub fn u(v: u64) -> U64 {
        U64(v)
    }
    pub fn i(v: i64) -> I64 {
        I64(v)
    }

    pub fn obs(event: ChainEvent, at: i64) -> Observed {
        Observed {
            source: "rpc0".into(),
            signature: Some(format!("sig{at}")),
            slot: at as u64,
            received_at: at,
            event,
        }
    }

    pub fn bg(e: BgEvent, at: i64) -> Observed {
        obs(ChainEvent::Breakglass(e), at)
    }
}
