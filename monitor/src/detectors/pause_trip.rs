use super::Detector;
use crate::decode::BgEvent;
use crate::event::{rfc3339, ChainEvent, Observed, Severity, Signal};

/// `LimitTripped` and the auto-trip `Paused` are one root cause (Critical).
/// Guardian/admin pauses, renewals and unpauses are High.
pub struct PauseTrip;

fn scopes(mask: u64) -> String {
    let s: Vec<String> = (0..64)
        .filter(|b| mask & (1u64 << b) != 0)
        .map(|b| b.to_string())
        .collect();
    s.join(",")
}

const KIND: [&str; 3] = ["guardian", "auto-trip", "admin"];

impl Detector for PauseTrip {
    fn name(&self) -> &'static str {
        "pause_trip"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let ChainEvent::Breakglass(e) = &ev.event else {
            return vec![];
        };
        let sig = ev.signature.clone();
        let mk = |severity, title: String, detail: String, actions: &str, key: String| {
            vec![Signal {
                detector: "pause_trip",
                severity,
                title,
                detail,
                actions: actions.into(),
                signature: sig.clone(),
                dedupe_key: key,
            }]
        };
        match e {
            BgEvent::LimitTripped(t) => mk(
                Severity::Critical,
                format!("LimitTripped: outflow cap hit, scope {} auto-paused until {}", t.scope, rfc3339(t.paused_until.0)),
                format!(
                    "window {}/{} on mint {}; the withdrawal that crossed the cap is held",
                    t.window_total.0, t.window_cap.0, t.mint
                ),
                "Investigate now. Admin: renew_pause to extend or unpause to reopen. Guardian: freeze_held on suspicious holds.",
                format!("trip:{}", t.scope),
            ),
            BgEvent::Paused(p) if p.kind == 1 => mk(
                Severity::Critical,
                format!("Paused: scope {} auto-tripped until {}", scopes(p.scopes_mask.0), rfc3339(p.paused_until.0)),
                format!("by limiter {}", p.by),
                "Only the admin can lift an auto-trip.",
                format!("trip:{}", scopes(p.scopes_mask.0)),
            ),
            BgEvent::Paused(p) => mk(
                Severity::High,
                format!(
                    "Paused: scopes {} paused by {} ({}) until {}",
                    scopes(p.scopes_mask.0),
                    p.by,
                    KIND.get(p.kind as usize).unwrap_or(&"?"),
                    rfc3339(p.paused_until.0)
                ),
                format!("reason code {}", p.reason),
                "Admin: confirm the incident or unpause. Guardian: renew_pause if more time is needed.",
                format!("pause:{}", scopes(p.scopes_mask.0)),
            ),
            BgEvent::PauseRenewed(p) => mk(
                Severity::High,
                format!("PauseRenewed: scopes {} extended to {} by {}", scopes(p.scopes_mask.0), rfc3339(p.paused_until.0), p.by),
                format!("renewal {}", p.renewals),
                "Admin: extend past the guardian cap or unpause.",
                format!("pause:{}", scopes(p.scopes_mask.0)),
            ),
            BgEvent::Unpaused(p) => mk(
                Severity::High,
                format!("Unpaused: scopes {} reopened by {}", scopes(p.scopes_mask.0), p.by),
                String::new(),
                "Confirm the root cause is fixed; watch outflows closely.",
                format!("unpause:{}:{}", scopes(p.scopes_mask.0), ev.signature.clone().unwrap_or_default()),
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
    fn trip_and_its_auto_pause_are_one_critical_incident() {
        let trip = bg(
            BgEvent::LimitTripped(LimitTripped {
                config: pk(1),
                mint: pk(2),
                scope: 1,
                window_total: u(900),
                window_cap: u(1000),
                paused_until: i(99),
            }),
            1,
        );
        let paused = bg(
            BgEvent::Paused(Paused {
                config: pk(1),
                scopes_mask: u(2),
                paused_until: i(99),
                by: pk(3),
                kind: 1,
                reason: 1,
            }),
            1,
        );
        let a = PauseTrip.observe(&trip);
        let b = PauseTrip.observe(&paused);
        assert_eq!(a[0].severity, Severity::Critical);
        assert_eq!(b[0].severity, Severity::Critical);
        assert_eq!(a[0].dedupe_key, b[0].dedupe_key);
        assert!(a[0].title.starts_with("LimitTripped"));
    }

    #[test]
    fn guardian_pause_and_unpause_are_high() {
        let p = bg(
            BgEvent::Paused(Paused {
                config: pk(1),
                scopes_mask: u(3),
                paused_until: i(9),
                by: pk(4),
                kind: 0,
                reason: 7,
            }),
            1,
        );
        let out = PauseTrip.observe(&p);
        assert_eq!(out[0].severity, Severity::High);
        assert!(out[0].title.contains("scopes 0,1"));
        let un = bg(
            BgEvent::Unpaused(Unpaused {
                config: pk(1),
                scopes_mask: u(3),
                by: pk(4),
            }),
            2,
        );
        assert_eq!(PauseTrip.observe(&un)[0].severity, Severity::High);
    }

    #[test]
    fn ignores_unrelated_events() {
        let ev = obs(
            ChainEvent::Heartbeat {
                source: "rpc0".into(),
            },
            1,
        );
        assert!(PauseTrip.observe(&ev).is_empty());
        let o = bg(
            BgEvent::HoldFrozen(HoldFrozen {
                config: pk(1),
                hold: pk(2),
                by: pk(3),
            }),
            1,
        );
        assert!(PauseTrip.observe(&o).is_empty());
    }
}
