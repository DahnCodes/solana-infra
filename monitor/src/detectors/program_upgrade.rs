use std::collections::HashMap;

use super::Detector;
use crate::event::{ChainEvent, Observed, Severity, Signal};

/// Critical when a watched program's ProgramData changes (new code, upgrade
/// slot or upgrade authority). The first observation is the baseline.
pub struct ProgramUpgrade {
    labels: HashMap<String, String>,
    hashes: HashMap<String, String>,
}

impl ProgramUpgrade {
    /// `programs`: (program id, label) pairs.
    pub fn new(programs: Vec<(String, String)>) -> Self {
        Self {
            labels: programs.into_iter().collect(),
            hashes: HashMap::new(),
        }
    }
}

impl Detector for ProgramUpgrade {
    fn name(&self) -> &'static str {
        "program_upgrade"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let ChainEvent::ProgramData { program, hash } = &ev.event else {
            return vec![];
        };
        match self.hashes.insert(program.clone(), hash.clone()) {
            Some(old) if old != *hash => {
                let label = self
                    .labels
                    .get(program)
                    .cloned()
                    .unwrap_or_else(|| "program".into());
                vec![Signal {
                    detector: self.name(),
                    severity: Severity::Critical,
                    title: format!("Program upgraded: {label} ({program})"),
                    detail: format!("ProgramData changed at slot {} (code, upgrade slot or upgrade authority)", ev.slot),
                    actions: "If this wasn't a planned upgrade: guardian pause every scope, admin secure the upgrade authority.".into(),
                    signature: None,
                    dedupe_key: format!("upgrade:{program}:{hash}"),
                }]
            }
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detectors::fixtures::*;

    fn pd(hash: &str, at: i64) -> Observed {
        obs(
            ChainEvent::ProgramData {
                program: "P".into(),
                hash: hash.into(),
            },
            at,
        )
    }

    #[test]
    fn baseline_then_change_is_critical_once() {
        let mut d = ProgramUpgrade::new(vec![("P".into(), "test-vault".into())]);
        assert!(d.observe(&pd("a", 1)).is_empty());
        assert!(
            d.observe(&pd("a", 2)).is_empty(),
            "same data from another RPC"
        );
        let out = d.observe(&pd("b", 3));
        assert_eq!(out[0].severity, Severity::Critical);
        assert!(out[0].title.contains("test-vault"));
        assert!(d.observe(&pd("b", 4)).is_empty());
    }
}
