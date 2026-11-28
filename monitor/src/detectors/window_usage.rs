use std::collections::HashMap;

use super::Detector;
use crate::decode::BgEvent;
use crate::event::{ChainEvent, Observed, Severity, Signal, Subject};

/// Warns when a mint's outflow window passes warning% / high% of its cap.
/// Fires once per level until usage drops back below it.
pub struct WindowUsage {
    warning_pct: u8,
    high_pct: u8,
    last_level: HashMap<String, Option<Severity>>,
}

impl WindowUsage {
    pub fn new(warning_pct: u8, high_pct: u8) -> Self {
        Self {
            warning_pct,
            high_pct,
            last_level: HashMap::new(),
        }
    }
}

impl Detector for WindowUsage {
    fn name(&self) -> &'static str {
        "window_usage"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let ChainEvent::Breakglass(BgEvent::OutflowRecorded(o)) = &ev.event else {
            return vec![];
        };
        if o.window_cap.0 == 0 {
            return vec![];
        }
        let mint = o.mint.to_string();
        let pct = (o.window_total.0 as u128 * 100 / o.window_cap.0 as u128) as u64;
        let level = if pct >= self.high_pct as u64 {
            Some(Severity::High)
        } else if pct >= self.warning_pct as u64 {
            Some(Severity::Warning)
        } else {
            None
        };
        let prev = self.last_level.insert(mint.clone(), level).flatten();
        match level {
            Some(sev) if prev.is_none_or(|p| sev > p) => vec![Signal {
                detector: self.name(),
                severity: sev,
                title: format!("OutflowRecorded: window at {pct}% of cap for mint {mint}"),
                detail: format!(
                    "{}/{} after a {} withdrawal by {}",
                    o.window_total.0, o.window_cap.0, o.amount.0, o.owner
                ),
                actions: "Watch for a trip. Guardian: pause early if outflows look abnormal."
                    .into(),
                signature: ev.signature.clone(),
                dedupe_key: format!("window:{mint}"),
                subject: Subject {
                    mint: Some(mint.clone()),
                    ..Default::default()
                },
            }],
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::*;
    use crate::detectors::fixtures::*;

    fn outflow(total: u64) -> Observed {
        bg(
            BgEvent::OutflowRecorded(OutflowRecorded {
                config: pk(1),
                mint: pk(2),
                owner: pk(3),
                amount: u(1),
                window_total: u(total),
                window_cap: u(100),
            }),
            1,
        )
    }

    #[test]
    fn escalates_once_per_level() {
        let mut d = WindowUsage::new(50, 80);
        assert!(d.observe(&outflow(10)).is_empty());
        assert_eq!(d.observe(&outflow(55))[0].severity, Severity::Warning);
        assert!(d.observe(&outflow(60)).is_empty());
        assert_eq!(d.observe(&outflow(85))[0].severity, Severity::High);
        assert!(d.observe(&outflow(90)).is_empty());
        // Drops back (window rolled), then climbs again: alerts again.
        assert!(d.observe(&outflow(10)).is_empty());
        assert_eq!(d.observe(&outflow(55))[0].severity, Severity::Warning);
    }
}
