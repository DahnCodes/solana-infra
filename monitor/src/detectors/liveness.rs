use std::collections::{HashMap, HashSet};

use super::Detector;
use crate::event::{ChainEvent, Observed, Severity, Signal};

/// High when an ingestor's websocket goes quiet for longer than the timeout;
/// Critical when every ingestor is quiet. One incident per outage.
pub struct Liveness {
    timeout: i64,
    last: HashMap<String, i64>,
    down: HashSet<String>,
    outages: HashMap<String, u32>,
    all_down: bool,
    all_outages: u32,
}

impl Liveness {
    /// Every source starts "seen at `now`", so one that never connects alerts after the timeout.
    pub fn new(sources: Vec<String>, timeout_secs: i64, now: i64) -> Self {
        Self {
            timeout: timeout_secs,
            last: sources.into_iter().map(|s| (s, now)).collect(),
            down: HashSet::new(),
            outages: HashMap::new(),
            all_down: false,
            all_outages: 0,
        }
    }
}

impl Detector for Liveness {
    fn name(&self) -> &'static str {
        "liveness"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        if let ChainEvent::Heartbeat { source } = &ev.event {
            self.last.insert(source.clone(), ev.received_at);
            self.down.remove(source);
            self.all_down = false;
        }
        vec![]
    }

    fn tick(&mut self, now: i64) -> Vec<Signal> {
        let mut out = vec![];
        let mut sources: Vec<_> = self.last.iter().map(|(s, t)| (s.clone(), *t)).collect();
        sources.sort();
        for (source, last) in sources {
            if now - last > self.timeout && self.down.insert(source.clone()) {
                let n = self.outages.entry(source.clone()).or_default();
                *n += 1;
                out.push(Signal {
                    detector: "liveness",
                    severity: Severity::High,
                    title: format!("Watcher {source} silent for {}s", now - last),
                    detail: "no websocket heartbeat; alerts keep flowing through the other RPCs if any are healthy".into(),
                    actions: "Check the RPC endpoint; restart or replace it.".into(),
                    signature: None,
                    dedupe_key: format!("liveness:{source}:{n}"),
                });
            }
        }
        if !self.last.is_empty() && self.down.len() == self.last.len() && !self.all_down {
            self.all_down = true;
            self.all_outages += 1;
            out.push(Signal {
                detector: "liveness",
                severity: Severity::Critical,
                title: "All watchers silent: the monitor is blind".into(),
                detail: "every ingestor missed its heartbeat; the on-chain limits still apply"
                    .into(),
                actions: "Restore an RPC now. Consider pausing until monitoring is back.".into(),
                signature: None,
                dedupe_key: format!("liveness:all:{}", self.all_outages),
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detectors::fixtures::*;

    fn hb(source: &str, at: i64) -> Observed {
        obs(
            ChainEvent::Heartbeat {
                source: source.into(),
            },
            at,
        )
    }

    #[test]
    fn a_silent_source_alerts_once_per_outage() {
        let mut d = Liveness::new(vec!["rpc0".into(), "rpc1".into()], 30, 0);
        d.observe(&hb("rpc0", 20));
        d.observe(&hb("rpc1", 20));
        assert!(d.tick(50).is_empty());
        d.observe(&hb("rpc0", 49));
        let out = d.tick(51);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::High);
        assert!(out[0].title.contains("rpc1"));
        assert!(d.tick(52).is_empty(), "once per outage");
        // Recovers, then fails again: a new incident.
        d.observe(&hb("rpc1", 60));
        d.observe(&hb("rpc0", 95));
        let again = d.tick(95);
        assert_eq!(again.len(), 1);
        assert_ne!(again[0].dedupe_key, out[0].dedupe_key);
    }

    #[test]
    fn a_source_that_never_connects_alerts_after_the_timeout() {
        let mut d = Liveness::new(vec!["rpc0".into(), "rpc1".into()], 30, 0);
        d.observe(&hb("rpc0", 10));
        d.observe(&hb("rpc0", 30));
        assert_eq!(d.tick(31).len(), 1);
    }

    #[test]
    fn all_silent_is_critical() {
        let mut d = Liveness::new(vec!["rpc0".into(), "rpc1".into()], 30, 0);
        let out = d.tick(31);
        assert_eq!(out.len(), 3);
        assert_eq!(out[2].severity, Severity::Critical);
        assert!(d.tick(40).is_empty());
    }
}
