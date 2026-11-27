use std::collections::HashMap;

use super::Detector;
use crate::decode::BgEvent;
use crate::event::{rfc3339, share, ChainEvent, Observed, Severity, Signal};

/// Held withdrawals and what happens to them. One incident per hold.
#[derive(Default)]
pub struct LargeWithdrawal {
    /// Latest vault balance per mint, for "share of TVL".
    vault_balance: HashMap<String, u64>,
}

impl Detector for LargeWithdrawal {
    fn name(&self) -> &'static str {
        "large_withdrawal"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let e = match &ev.event {
            ChainEvent::VaultBalance { mint, amount, .. } => {
                self.vault_balance.insert(mint.clone(), *amount);
                return vec![];
            }
            ChainEvent::Breakglass(e) => e,
            _ => return vec![],
        };
        let mk = |severity, title: String, detail: String, actions: &str, hold: String| {
            vec![Signal {
                detector: "large_withdrawal",
                severity,
                title,
                detail,
                actions: actions.into(),
                signature: ev.signature.clone(),
                dedupe_key: format!("hold:{hold}"),
            }]
        };
        match e {
            BgEvent::LargeWithdrawalQueued(h) => {
                let tvl = self.vault_balance.get(&h.mint.to_string()).copied();
                mk(
                    Severity::High,
                    format!("LargeWithdrawalQueued: {} ({} of the vault) held for {}", h.amount.0, share(h.amount.0, tvl), h.owner),
                    format!("hold {}, mint {}, releases at {}; decision: HOLD", h.hold, h.mint, rfc3339(h.release_at.0)),
                    "Legitimate: no action, the user claims after release. Suspicious: guardian freeze_held, then admin reject_held.",
                    h.hold.to_string(),
                )
            }
            BgEvent::HoldFrozen(h) => mk(
                Severity::Warning,
                format!("HoldFrozen: hold {} frozen by {}", h.hold, h.by),
                String::new(),
                "Admin: reject_held (returns funds to the user's position) or release through the timelock.",
                h.hold.to_string(),
            ),
            BgEvent::HoldResolved(h) if h.outcome == 1 => mk(
                Severity::High,
                format!("HoldResolved: hold {} RELEASED through the timelock", h.hold),
                "the user can claim it now".into(),
                "Verify the release was intended.",
                h.hold.to_string(),
            ),
            BgEvent::HoldResolved(h) if h.outcome == 2 => mk(
                Severity::Warning,
                format!("HoldResolved: hold {} rejected", h.hold),
                "the amount went back to the user's position".into(),
                "None.",
                h.hold.to_string(),
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

    fn queued() -> Observed {
        bg(
            BgEvent::LargeWithdrawalQueued(LargeWithdrawalQueued {
                config: pk(1),
                hold: pk(9),
                mint: pk(2),
                owner: pk(3),
                amount: u(500),
                release_at: i(1_800_000_000),
            }),
            5,
        )
    }

    #[test]
    fn held_withdrawal_pages_high_with_share_of_tvl() {
        let mut d = LargeWithdrawal::default();
        d.observe(&obs(
            ChainEvent::VaultBalance {
                vault: "V".into(),
                mint: pk(2).to_string(),
                amount: 10_000,
            },
            1,
        ));
        let out = d.observe(&queued());
        assert_eq!(out[0].severity, Severity::High);
        assert_eq!(out[0].dedupe_key, format!("hold:{}", pk(9)));
        assert!(
            out[0].title.contains("5.0% of the vault"),
            "{}",
            out[0].title
        );
        assert!(out[0].title.starts_with("LargeWithdrawalQueued"));
    }

    #[test]
    fn freeze_and_release_fold_into_the_hold_incident() {
        let mut d = LargeWithdrawal::default();
        let key = d.observe(&queued())[0].dedupe_key.clone();
        let f = d.observe(&bg(
            BgEvent::HoldFrozen(HoldFrozen {
                config: pk(1),
                hold: pk(9),
                by: pk(4),
            }),
            6,
        ));
        assert_eq!((f[0].severity, &f[0].dedupe_key), (Severity::Warning, &key));
        let r = d.observe(&bg(
            BgEvent::HoldResolved(HoldResolved {
                config: pk(1),
                hold: pk(9),
                outcome: 1,
            }),
            7,
        ));
        assert_eq!((r[0].severity, &r[0].dedupe_key), (Severity::High, &key));
        let c = d.observe(&bg(
            BgEvent::HoldResolved(HoldResolved {
                config: pk(1),
                hold: pk(9),
                outcome: 0,
            }),
            8,
        ));
        assert!(c.is_empty(), "claims are normal");
    }
}
