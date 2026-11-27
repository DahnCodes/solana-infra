use std::collections::HashMap;

use super::Detector;
use crate::event::{ChainEvent, Observed, Severity, Signal};

/// Warns when a mint's outflow window passes warning% / high% of its cap.
/// Fires once per level until usage drops back below it.
pub struct WindowUsage {
    warning_pct: u8,
    high_pct: u8,
    last_level: HashMap<String, Option<Severity>>,
}

impl WindowUsage {
    pub fn new(warning_pct: u8, high_pct: u8) -> Self {
        Self { warning_pct, high_pct, last_level: HashMap::new() }
    }
}

impl Detector for WindowUsage {
    fn name(&self) -> &'static str {
        "window_usage"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let ChainEvent::OutflowRecorded { mint, window_total, window_cap, .. } = &ev.event else {
            return vec![];
        };
        if *window_cap == 0 {
            return vec![];
        }
        let pct = (*window_total as u128 * 100 / *window_cap as u128) as u64;
        let level = if pct >= self.high_pct as u64 {
            Some(Severity::High)
        } else if pct >= self.warning_pct as u64 {
            Some(Severity::Warning)
        } else {
            None
        };
        let prev = self.last_level.insert(mint.clone(), level).flatten();
        match level {
            Some(sev) if prev.map_or(true, |p| sev > p) => vec![Signal {
                detector: self.name(),
                severity: sev,
                title: format!("Outflow window at {pct}% of cap for mint {mint}"),
                detail: format!("{window_total}/{window_cap}"),
                signature: ev.signature.clone(),
                dedupe_key: format!("window:{mint}"),
            }],
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outflow(total: u64) -> Observed {
        Observed {
            signature: None,
            slot: 1,
            event: ChainEvent::OutflowRecorded { mint: "M".into(), owner: "O".into(), amount: 1, window_total: total, window_cap: 100 },
        }
    }

    #[test]
    fn escalates_once_per_level() {
        let mut d = WindowUsage::new(50, 80);
        assert!(d.observe(&outflow(10)).is_empty());
        assert_eq!(d.observe(&outflow(55))[0].severity, Severity::Warning);
        assert!(d.observe(&outflow(60)).is_empty());
        assert_eq!(d.observe(&outflow(85))[0].severity, Severity::High);
        assert!(d.observe(&outflow(90)).is_empty());
    }
}
