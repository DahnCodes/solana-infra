use std::collections::HashMap;

use super::Detector;
use crate::decode::BgEvent;
use crate::event::{ChainEvent, Observed, Severity, Signal, Subject};

/// Critical when a vault's balance drops by more than the outflows Breakglass
/// recorded for its mint: tokens left through a path that skipped the gate.
///
/// Account updates (processed) usually arrive before the transaction's events
/// (fetched at confirmed), so a drop must stay unexplained for `grace_secs`
/// before it alerts. A surplus of recorded outflows (deposit and withdrawal
/// netting out inside one update) is forgiven after the same grace.
pub struct BalanceDelta {
    tolerance: u64,
    grace: i64,
    prev: HashMap<String, u64>,
    mints: HashMap<String, MintState>,
}

#[derive(Default)]
struct MintState {
    vault: String,
    /// Drops seen minus outflows recorded. Positive = unexplained.
    unexplained: i128,
    over_since: Option<i64>,
    credit_since: Option<i64>,
    last_slot: u64,
}

impl BalanceDelta {
    pub fn new(tolerance: u64, grace_secs: u64) -> Self {
        Self {
            tolerance,
            grace: grace_secs as i64,
            prev: HashMap::new(),
            mints: HashMap::new(),
        }
    }

    fn settle(st: &mut MintState, tolerance: u64, now: i64) {
        if st.unexplained > tolerance as i128 {
            st.over_since.get_or_insert(now);
            st.credit_since = None;
        } else if st.unexplained < 0 {
            st.credit_since.get_or_insert(now);
            st.over_since = None;
        } else {
            st.over_since = None;
            st.credit_since = None;
        }
    }
}

impl Detector for BalanceDelta {
    fn name(&self) -> &'static str {
        "balance_delta"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let now = ev.received_at;
        match &ev.event {
            ChainEvent::VaultBalance {
                vault,
                mint,
                amount,
            } => {
                let st = self.mints.entry(mint.clone()).or_default();
                st.vault = vault.clone();
                st.last_slot = ev.slot;
                if let Some(prev) = self.prev.insert(vault.clone(), *amount) {
                    if *amount < prev {
                        st.unexplained += (prev - amount) as i128;
                    }
                }
                Self::settle(st, self.tolerance, now);
            }
            ChainEvent::Breakglass(BgEvent::OutflowRecorded(o)) => {
                let st = self.mints.entry(o.mint.to_string()).or_default();
                st.unexplained -= o.amount.0 as i128;
                Self::settle(st, self.tolerance, now);
            }
            _ => {}
        }
        vec![]
    }

    fn tick(&mut self, now: i64) -> Vec<Signal> {
        let mut out = vec![];
        for (mint, st) in self.mints.iter_mut() {
            if st.over_since.is_some_and(|t| now - t >= self.grace) {
                out.push(Signal {
                    detector: "balance_delta",
                    severity: Severity::Critical,
                    title: format!(
                        "Unexplained vault outflow: {} left vault {} with no Breakglass OutflowRecorded",
                        st.unexplained, st.vault
                    ),
                    detail: format!("mint {mint}, last seen at slot {}; decision: none (the gate never saw it)", st.last_slot),
                    actions: "Likely an unprotected instruction. Guardian: pause all protected scopes now (the bot does this from Phase 6). Find the path.".into(),
                    signature: None,
                    dedupe_key: format!("balance:{mint}"),
                    subject: Subject { mint: Some(mint.clone()), ..Default::default() },
                });
                st.unexplained = 0;
                st.over_since = None;
            }
            if st.credit_since.is_some_and(|t| now - t >= self.grace) {
                st.unexplained = 0;
                st.credit_since = None;
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::*;
    use crate::detectors::fixtures::*;

    fn bal(amount: u64, at: i64) -> Observed {
        obs(
            ChainEvent::VaultBalance {
                vault: "V".into(),
                mint: pk(2).to_string(),
                amount,
            },
            at,
        )
    }
    fn outflow(amount: u64, at: i64) -> Observed {
        bg(
            BgEvent::OutflowRecorded(OutflowRecorded {
                config: pk(1),
                mint: pk(2),
                owner: pk(3),
                amount: u(amount),
                window_total: u(amount),
                window_cap: u(1_000),
            }),
            at,
        )
    }

    #[test]
    fn recorded_outflows_explain_drops_in_either_order() {
        let mut d = BalanceDelta::new(0, 15);
        d.observe(&bal(10_000, 0));
        d.observe(&bal(9_900, 1)); // account update first
        d.observe(&outflow(100, 3)); // events a bit later
        d.observe(&outflow(50, 4)); // events first
        d.observe(&bal(9_850, 5));
        assert!(d.tick(100).is_empty());
    }

    #[test]
    fn an_unexplained_drop_is_critical_after_the_grace() {
        let mut d = BalanceDelta::new(0, 15);
        d.observe(&bal(10_000, 0));
        d.observe(&bal(7_000, 10));
        assert!(d.tick(24).is_empty(), "inside the grace window");
        let out = d.tick(25);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::Critical);
        assert!(out[0].title.contains("3000"));
        assert!(d.tick(60).is_empty(), "alerted once");
    }

    #[test]
    fn partially_explained_drop_alerts_for_the_rest() {
        let mut d = BalanceDelta::new(0, 15);
        d.observe(&bal(10_000, 0));
        d.observe(&outflow(100, 1));
        d.observe(&bal(8_900, 1));
        assert!(d.tick(30)[0].title.contains("1000"));
    }

    #[test]
    fn deposits_are_not_drops_and_tolerance_applies() {
        let mut d = BalanceDelta::new(5, 15);
        d.observe(&bal(10_000, 0));
        d.observe(&bal(12_000, 1));
        d.observe(&bal(11_996, 2)); // 4 <= tolerance (fees, rounding)
        assert!(d.tick(100).is_empty());
    }

    #[test]
    fn a_stale_credit_is_forgiven_and_cant_mask_a_later_theft() {
        let mut d = BalanceDelta::new(0, 15);
        d.observe(&bal(10_000, 0));
        // Deposit 100 and withdraw 100 netted out in one update: outflow with no drop.
        d.observe(&outflow(100, 1));
        assert!(d.tick(20).is_empty());
        // Much later an unprotected drain of 100: must not be "explained" by the old credit.
        d.observe(&bal(9_900, 50));
        assert_eq!(d.tick(70).len(), 1);
    }

    #[test]
    fn first_balance_is_only_a_baseline() {
        let mut d = BalanceDelta::new(0, 15);
        d.observe(&bal(10, 0));
        assert!(d.tick(100).is_empty());
    }
}
