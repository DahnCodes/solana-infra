use super::Detector;
use crate::event::{ChainEvent, Observed, Severity, Signal};

pub struct PauseTrip;

impl Detector for PauseTrip {
    fn name(&self) -> &'static str {
        "pause_trip"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let (severity, title, key) = match &ev.event {
            ChainEvent::LimitTripped { mint, scope, window_total, window_cap } => (
                Severity::Critical,
                format!("Outflow limit tripped on scope {scope}: {window_total}/{window_cap} for mint {mint}"),
                format!("trip:{mint}:{scope}"),
            ),
            ChainEvent::Paused { scopes_mask, by, .. } => (
                Severity::High,
                format!("Scopes {scopes_mask:#x} paused by {by}"),
                format!("pause:{scopes_mask}"),
            ),
            ChainEvent::Unpaused { scopes_mask, by } => (
                Severity::High,
                format!("Scopes {scopes_mask:#x} unpaused by {by}"),
                format!("unpause:{scopes_mask}"),
            ),
            _ => return vec![],
        };
        vec![Signal {
            detector: self.name(),
            severity,
            title,
            detail: format!("slot {}", ev.slot),
            signature: ev.signature.clone(),
            dedupe_key: key,
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trip_is_critical() {
        let ev = Observed {
            signature: Some("sig".into()),
            slot: 10,
            event: ChainEvent::LimitTripped { mint: "M".into(), scope: 1, window_total: 100, window_cap: 100 },
        };
        let out = PauseTrip.observe(&ev);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::Critical);
    }

    #[test]
    fn ignores_unrelated_events() {
        let ev = Observed {
            signature: None,
            slot: 1,
            event: ChainEvent::Heartbeat { source: "rpc0".into(), unix_ts: 0 },
        };
        assert!(PauseTrip.observe(&ev).is_empty());
    }
}
