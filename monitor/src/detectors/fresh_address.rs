use std::collections::HashMap;

use super::{hold_request, Detector};
use crate::decode::BgEvent;
use crate::event::{ChainEvent, Observed, Severity, Signal, Subject};

/// High when a withdrawal comes from a wallet first seen less than `max_age`
/// ago, or one whose first transaction touched a configured mixer/bridge.
/// A wallet the monitor couldn't profile counts as unverified (fail closed).
/// On a held withdrawal the guardian bot freezes it.
pub struct FreshAddress {
    max_age: i64,
    profiles: HashMap<String, (Option<i64>, Option<String>)>,
}

impl FreshAddress {
    pub fn new(max_age_secs: u64) -> Self {
        Self {
            max_age: max_age_secs as i64,
            profiles: HashMap::new(),
        }
    }

    /// Why this wallet is suspicious, if it is.
    fn verdict(&self, wallet: &str, now: i64) -> Option<String> {
        match self.profiles.get(wallet) {
            None | Some((None, None)) => {
                Some("wallet history could not be checked (unverified)".into())
            }
            Some((_, Some(funder))) => Some(format!(
                "first transaction touched flagged address {funder}"
            )),
            Some((Some(first), None)) if now - first < self.max_age => {
                Some(format!("wallet first seen {}s ago", (now - first).max(0)))
            }
            _ => None,
        }
    }
}

impl Detector for FreshAddress {
    fn name(&self) -> &'static str {
        "fresh_address"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let now = ev.received_at;
        match &ev.event {
            ChainEvent::WalletProfile {
                wallet,
                first_seen,
                flagged_funder,
            } => {
                self.profiles
                    .insert(wallet.clone(), (*first_seen, flagged_funder.clone()));
                vec![]
            }
            ChainEvent::Breakglass(e) => {
                let (owner, mint, amount, hold) = if let Some(h) = hold_request(e) {
                    (h.owner, h.mint, h.amount, Some(h.hold))
                } else if let BgEvent::OutflowRecorded(o) = e {
                    (o.owner.to_string(), o.mint.to_string(), o.amount.0, None)
                } else {
                    return vec![];
                };
                let Some(why) = self.verdict(&owner, now) else {
                    return vec![];
                };
                let (title, actions, key) = match &hold {
                    Some(h) => (
                        format!("Fresh wallet: held withdrawal of {amount} by {owner}"),
                        "Guardian bot freezes it; admin can reject_held, or release through the timelock if legitimate.",
                        format!("fresh:{h}"),
                    ),
                    None => (
                        format!("Fresh wallet: withdrawal of {amount} by {owner} was paid out"),
                        "Already paid (not held). Consider screen-all mode (instant allowance 0).",
                        format!("fresh:{}", ev.signature.clone().unwrap_or_default()),
                    ),
                };
                vec![Signal {
                    detector: "fresh_address",
                    severity: Severity::High,
                    title,
                    detail: format!("{why}; mint {mint}"),
                    actions: actions.into(),
                    signature: ev.signature.clone(),
                    dedupe_key: key,
                    subject: Subject {
                        hold,
                        owner: Some(owner),
                        mint: Some(mint),
                    },
                }]
            }
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::*;
    use crate::detectors::fixtures::*;

    fn profile(wallet: Pk, first_seen: Option<i64>, funder: Option<&str>, at: i64) -> Observed {
        obs(
            ChainEvent::WalletProfile {
                wallet: wallet.to_string(),
                first_seen,
                flagged_funder: funder.map(String::from),
            },
            at,
        )
    }
    fn screened(owner: Pk, at: i64) -> Observed {
        bg(
            BgEvent::WithdrawalScreenQueued(WithdrawalScreenQueued {
                config: pk(1),
                hold: pk(9),
                mint: pk(2),
                owner,
                amount: u(3_000),
                release_at: i(at + 120),
            }),
            at,
        )
    }

    #[test]
    fn a_young_wallet_is_flagged_with_the_hold_to_freeze() {
        let mut d = FreshAddress::new(86_400);
        d.observe(&profile(pk(7), Some(1_000_000 - 60), None, 1_000_000));
        let out = d.observe(&screened(pk(7), 1_000_000));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::High);
        assert_eq!(out[0].subject.hold, Some(pk(9).to_string()));
        assert!(out[0].detail.contains("first seen 60s ago"));
    }

    #[test]
    fn an_old_wallet_is_clean() {
        let mut d = FreshAddress::new(86_400);
        d.observe(&profile(pk(7), Some(1_000_000 - 90_000), None, 1_000_000));
        assert!(d.observe(&screened(pk(7), 1_000_000)).is_empty());
    }

    #[test]
    fn a_flagged_funder_is_flagged_even_if_old() {
        let mut d = FreshAddress::new(86_400);
        d.observe(&profile(pk(7), Some(0), Some("Mixer111"), 1_000_000));
        assert!(d.observe(&screened(pk(7), 1_000_000))[0]
            .detail
            .contains("Mixer111"));
    }

    #[test]
    fn an_unprofiled_wallet_is_unverified_and_flagged() {
        let mut d = FreshAddress::new(86_400);
        assert!(d.observe(&screened(pk(7), 1_000_000))[0]
            .detail
            .contains("unverified"));
        d.observe(&profile(pk(8), None, None, 1_000_000));
        assert_eq!(d.observe(&screened(pk(8), 1_000_000)).len(), 1);
    }

    #[test]
    fn a_paid_outflow_alerts_without_a_hold() {
        let mut d = FreshAddress::new(86_400);
        d.observe(&profile(pk(3), Some(999_990), None, 1_000_000));
        let o = bg(
            BgEvent::OutflowRecorded(OutflowRecorded {
                config: pk(1),
                mint: pk(2),
                owner: pk(3),
                amount: u(5),
                window_total: u(5),
                window_cap: u(100),
            }),
            1_000_000,
        );
        let out = d.observe(&o);
        assert_eq!(out[0].subject.hold, None);
    }
}
