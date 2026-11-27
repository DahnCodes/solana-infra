//! Detectors: pure functions from an observed event (plus their own state) to
//! signals. No network I/O, so each one is unit-tested with fixtures.
//! Time-based checks (liveness, unexplained balance drops) run in `tick`.

use crate::event::{Observed, Signal};

mod balance_delta;
mod config_change;
mod large_withdrawal;
mod liveness;
mod pause_trip;
mod program_upgrade;
mod window_usage;

pub use balance_delta::BalanceDelta;
pub use config_change::ConfigChange;
pub use large_withdrawal::LargeWithdrawal;
pub use liveness::Liveness;
pub use pause_trip::PauseTrip;
pub use program_upgrade::ProgramUpgrade;
pub use window_usage::WindowUsage;

pub trait Detector: Send {
    fn name(&self) -> &'static str;
    fn observe(&mut self, ev: &Observed) -> Vec<Signal>;
    /// Called about once a second with the wall clock (unix seconds).
    fn tick(&mut self, _now: i64) -> Vec<Signal> {
        vec![]
    }
}

pub fn default_set(
    cfg: &crate::config::DetectorConfig,
    sources: Vec<String>,
    program_names: Vec<(String, String)>,
    now: i64,
) -> Vec<Box<dyn Detector>> {
    vec![
        Box::new(PauseTrip),
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
        // Phase 6: VelocityBaseline, FreshAddress
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
