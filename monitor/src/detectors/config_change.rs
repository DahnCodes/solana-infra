use std::collections::HashMap;

use super::Detector;
use crate::decode::{action_kind_name, BgEvent};
use crate::event::{rfc3339, ChainEvent, Observed, Severity, Signal};

/// Timelocked changes, guardian removal and immediate tightening.
/// One incident per pending change.
#[derive(Default)]
pub struct ConfigChange {
    kinds: HashMap<String, u8>,
}

impl Detector for ConfigChange {
    fn name(&self) -> &'static str {
        "config_change"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let ChainEvent::Breakglass(e) = &ev.event else {
            return vec![];
        };
        let mk = |severity, title: String, detail: String, actions: String, key: String| {
            vec![Signal {
                detector: "config_change",
                severity,
                title,
                detail,
                actions,
                signature: ev.signature.clone(),
                dedupe_key: key,
                subject: Default::default(),
            }]
        };
        match e {
            BgEvent::ConfigChangeProposed(p) => {
                self.kinds.insert(p.change.to_string(), p.action_kind);
                let at = rfc3339(p.executable_at.0);
                mk(
                    Severity::High,
                    format!("ConfigChangeProposed: {} queued, executable at {at}", action_kind_name(p.action_kind)),
                    format!("change {}", p.change),
                    format!("Review the PendingConfig. If unexpected (stolen admin key?): guardian veto_config before {at}; admin cancel_config."),
                    format!("change:{}", p.change),
                )
            }
            BgEvent::ConfigChangeExecuted(x) => {
                let kind = self.kinds.get(&x.change.to_string()).map(|k| action_kind_name(*k)).unwrap_or("change");
                mk(
                    Severity::High,
                    format!("ConfigChangeExecuted: {kind} applied"),
                    format!("change {}", x.change),
                    "Verify the new config is what was intended.".into(),
                    format!("change:{}", x.change),
                )
            }
            BgEvent::ConfigChangeVetoed(x) => mk(
                Severity::Warning,
                format!("ConfigChangeVetoed: change vetoed by guardian {}", x.by),
                format!("change {}", x.change),
                "None; it can never execute.".into(),
                format!("change:{}", x.change),
            ),
            BgEvent::ConfigChangeCancelled(x) => mk(
                Severity::Warning,
                "ConfigChangeCancelled: change cancelled by the admin".into(),
                format!("change {}", x.change),
                "None.".into(),
                format!("change:{}", x.change),
            ),
            BgEvent::GuardianRemoved(g) => mk(
                Severity::High,
                format!("GuardianRemoved: guardian {} removed", g.guardian),
                "removal is immediate".into(),
                "If unexpected, the admin key may be compromised: with no guardians left nobody can veto its next proposal.".into(),
                format!("guardian:{}", g.guardian),
            ),
            BgEvent::LimitsTightened(t) => mk(
                Severity::Warning,
                format!("LimitsTightened: limiter for mint {} tightened", t.mint),
                format!("limiter {}", t.flow_limiter),
                "None (tightening needs no timelock).".into(),
                format!("tighten:{}:{}", t.mint, ev.signature.clone().unwrap_or_default()),
            ),
            BgEvent::ConfigInitialized(c) => mk(
                Severity::Info,
                format!("ConfigInitialized: protocol {} registered", c.protected_program),
                format!("admin {}, {} guardians", c.admin, c.guardians.len()),
                "None.".into(),
                format!("init:{}", c.config),
            ),
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::*;
    use crate::detectors::fixtures::*;

    #[test]
    fn proposal_is_high_and_execution_knows_its_kind() {
        let mut d = ConfigChange::default();
        let p = d.observe(&bg(
            BgEvent::ConfigChangeProposed(ConfigChangeProposed {
                config: pk(1),
                change: pk(7),
                action_kind: 2,
                executable_at: i(1_800_000_000),
            }),
            1,
        ));
        assert_eq!(p[0].severity, Severity::High);
        assert!(p[0].title.contains("SetAdmin"));
        let x = d.observe(&bg(
            BgEvent::ConfigChangeExecuted(ConfigChangeExecuted {
                config: pk(1),
                change: pk(7),
            }),
            2,
        ));
        assert!(x[0].title.contains("SetAdmin applied"));
        assert_eq!(x[0].dedupe_key, p[0].dedupe_key);
    }

    #[test]
    fn veto_cancel_and_guardian_removal() {
        let mut d = ConfigChange::default();
        let v = d.observe(&bg(
            BgEvent::ConfigChangeVetoed(ConfigChangeVetoed {
                config: pk(1),
                change: pk(7),
                by: pk(3),
            }),
            1,
        ));
        assert_eq!(v[0].severity, Severity::Warning);
        let c = d.observe(&bg(
            BgEvent::ConfigChangeCancelled(ConfigChangeCancelled {
                config: pk(1),
                change: pk(8),
            }),
            1,
        ));
        assert_eq!(c[0].severity, Severity::Warning);
        let g = d.observe(&bg(
            BgEvent::GuardianRemoved(GuardianRemoved {
                config: pk(1),
                guardian: pk(3),
            }),
            1,
        ));
        assert_eq!(g[0].severity, Severity::High);
    }
}
