//! Detectors: pure functions from an observed event (plus their own state) to signals.
//! Keep them free of network I/O so they can be unit-tested with fixtures.

use crate::event::{Observed, Signal};

mod large_withdrawal;
mod pause_trip;
mod window_usage;

pub use large_withdrawal::LargeWithdrawal;
pub use pause_trip::PauseTrip;
pub use window_usage::WindowUsage;

pub trait Detector: Send {
    fn name(&self) -> &'static str;
    fn observe(&mut self, ev: &Observed) -> Vec<Signal>;
}

pub fn default_set(cfg: &crate::config::DetectorConfig) -> Vec<Box<dyn Detector>> {
    vec![
        Box::new(PauseTrip),
        Box::new(LargeWithdrawal),
        Box::new(WindowUsage::new(cfg.window_warning_pct, cfg.window_high_pct)),
        // Phase 5: BalanceDelta, ConfigChange, ProgramUpgrade, Liveness
        // Phase 6: VelocityBaseline, FreshAddress
    ]
}
