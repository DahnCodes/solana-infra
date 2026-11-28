use std::collections::{HashMap, HashSet};

use super::{hold_request, Detector};
use crate::decode::BgEvent;
use crate::event::{ChainEvent, Observed, Severity, Signal, Subject};

/// High when a held withdrawal is larger than what the wallet ever deposited
/// (minus what it already withdrew or has held). It only judges what it can
/// see completely: mints whose vault the monitor watches (deposits are read
/// from that vault's balance changes), and wallets whose whole history the
/// monitor saw (first seen after `history_start`). Anything else stays quiet.
pub struct DepositHistory {
    history_start: i64,
    first_seen: HashMap<String, Option<i64>>,
    /// (owner, mint) -> deposited, withdrawn, held
    books: HashMap<(String, String), Books>,
    /// hold -> (owner, mint, amount) while it's pending
    holds: HashMap<String, (String, String, u128)>,
    /// Mints with a watched vault (learned from VaultBalance events).
    watched_mints: HashSet<String>,
}

#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct Books {
    pub deposited: u128,
    pub withdrawn: u128,
    pub held: u128,
}

impl DepositHistory {
    pub fn new(history_start: i64) -> Self {
        Self {
            history_start,
            first_seen: HashMap::new(),
            books: HashMap::new(),
            holds: HashMap::new(),
            watched_mints: HashSet::new(),
        }
    }

    /// Seed from the store: books per (owner, mint) and pending holds.
    pub fn seed(
        &mut self,
        books: Vec<(String, String, Books)>,
        holds: Vec<(String, String, String, u128)>,
    ) {
        for (owner, mint, b) in books {
            self.books.insert((owner, mint), b);
        }
        for (hold, owner, mint, amount) in holds {
            self.holds.insert(hold, (owner, mint, amount));
        }
    }
}

impl Detector for DepositHistory {
    fn name(&self) -> &'static str {
        "deposit_history"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        match &ev.event {
            ChainEvent::WalletProfile {
                wallet, first_seen, ..
            } => {
                self.first_seen.insert(wallet.clone(), *first_seen);
            }
            ChainEvent::VaultBalance { mint, .. } => {
                self.watched_mints.insert(mint.clone());
            }
            ChainEvent::Deposit {
                owner,
                mint,
                amount,
                ..
            } => {
                self.books
                    .entry((owner.clone(), mint.clone()))
                    .or_default()
                    .deposited += *amount as u128;
            }
            ChainEvent::Breakglass(BgEvent::OutflowRecorded(o)) => {
                self.books
                    .entry((o.owner.to_string(), o.mint.to_string()))
                    .or_default()
                    .withdrawn += o.amount.0 as u128;
            }
            ChainEvent::Breakglass(BgEvent::HoldResolved(r)) if r.outcome != 1 => {
                // Claimed (its OutflowRecorded follows) or rejected (back to the position).
                if let Some((owner, mint, amount)) = self.holds.remove(&r.hold.to_string()) {
                    let b = self.books.entry((owner, mint)).or_default();
                    b.held = b.held.saturating_sub(amount);
                }
            }
            ChainEvent::Breakglass(e) => {
                let Some(h) = hold_request(e) else {
                    return vec![];
                };
                let key = (h.owner.clone(), h.mint.clone());
                let before = self.books.get(&key).copied().unwrap_or_default();
                self.holds.insert(
                    h.hold.clone(),
                    (h.owner.clone(), h.mint.clone(), h.amount as u128),
                );
                self.books.entry(key).or_default().held += h.amount as u128;

                // Only judge what we can see completely: a watched vault for this
                // mint (so its deposits are visible) and a wallet born after our
                // records began.
                if !self.watched_mints.contains(&h.mint) {
                    return vec![];
                }
                let known_whole_history = matches!(self.first_seen.get(&h.owner), Some(Some(t)) if *t >= self.history_start);
                if !known_whole_history {
                    return vec![];
                }
                let available = before
                    .deposited
                    .saturating_sub(before.withdrawn + before.held);
                if (h.amount as u128) <= available {
                    return vec![];
                }
                return vec![Signal {
                    detector: "deposit_history",
                    severity: Severity::High,
                    title: format!(
                        "Withdrawal exceeds deposits: {} held for {} who deposited {}",
                        h.amount, h.owner, before.deposited
                    ),
                    detail: format!(
                        "withdrawn {}, already held {}, available {available}; mint {}",
                        before.withdrawn, before.held, h.mint
                    ),
                    actions: "Guardian bot freezes it; admin can reject_held.".into(),
                    signature: ev.signature.clone(),
                    dedupe_key: format!("deposit:{}", h.hold),
                    subject: Subject {
                        hold: Some(h.hold),
                        owner: Some(h.owner),
                        mint: Some(h.mint),
                    },
                }];
            }
            _ => {}
        }
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::*;
    use crate::detectors::fixtures::*;

    fn profile(w: Pk, t: i64) -> Observed {
        obs(
            ChainEvent::WalletProfile {
                wallet: w.to_string(),
                first_seen: Some(t),
                flagged_funder: None,
            },
            t,
        )
    }
    fn watched() -> Observed {
        obs(
            ChainEvent::VaultBalance {
                vault: "V".into(),
                mint: pk(2).to_string(),
                amount: 0,
            },
            0,
        )
    }
    fn deposit(w: Pk, amount: u64) -> Observed {
        obs(
            ChainEvent::Deposit {
                owner: w.to_string(),
                mint: pk(2).to_string(),
                vault: "V".into(),
                amount,
            },
            1,
        )
    }
    fn held(w: Pk, hold: u8, amount: u64) -> Observed {
        bg(
            BgEvent::WithdrawalScreenQueued(WithdrawalScreenQueued {
                config: pk(1),
                hold: pk(hold),
                mint: pk(2),
                owner: w,
                amount: u(amount),
                release_at: i(9),
            }),
            1,
        )
    }

    #[test]
    fn more_than_deposited_is_flagged_for_wallets_with_known_history() {
        let mut d = DepositHistory::new(100);
        d.observe(&watched());
        d.observe(&profile(pk(7), 500));
        d.observe(&deposit(pk(7), 100));
        assert!(d.observe(&held(pk(7), 20, 60)).is_empty());
        // 60 already held: only 40 left.
        let out = d.observe(&held(pk(7), 21, 50));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].subject.hold, Some(pk(21).to_string()));
        assert!(out[0].title.contains("deposited 100"));
    }

    #[test]
    fn wallets_older_than_the_history_are_not_judged() {
        let mut d = DepositHistory::new(100);
        d.observe(&profile(pk(7), 50));
        assert!(d.observe(&held(pk(7), 20, 1_000_000)).is_empty());
        assert!(
            DepositHistory::new(100)
                .observe(&held(pk(8), 20, 5))
                .is_empty(),
            "unknown profile: not judged here"
        );
    }

    #[test]
    fn a_rejected_hold_frees_its_amount_again() {
        let mut d = DepositHistory::new(100);
        d.observe(&watched());
        d.observe(&profile(pk(7), 500));
        d.observe(&deposit(pk(7), 100));
        d.observe(&held(pk(7), 20, 100));
        d.observe(&bg(
            BgEvent::HoldResolved(HoldResolved {
                config: pk(1),
                hold: pk(20),
                outcome: 2,
            }),
            2,
        ));
        assert!(d.observe(&held(pk(7), 21, 100)).is_empty());
    }

    #[test]
    fn mints_without_a_watched_vault_are_not_judged() {
        // No VaultBalance for this mint: its deposits are invisible, so a
        // withdrawal can't be compared with them (it would flag everyone).
        let mut d = DepositHistory::new(100);
        d.observe(&profile(pk(7), 500));
        assert!(d.observe(&held(pk(7), 20, 1_000)).is_empty());
        d.observe(&watched());
        assert_eq!(d.observe(&held(pk(7), 21, 1_000)).len(), 1);
    }
}
