use super::Detector;
use crate::event::{ChainEvent, Observed, Severity, Signal};

pub struct LargeWithdrawal;

impl Detector for LargeWithdrawal {
    fn name(&self) -> &'static str {
        "large_withdrawal"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        match &ev.event {
            ChainEvent::LargeWithdrawalQueued { hold, owner, amount, release_at } => vec![Signal {
                detector: self.name(),
                severity: Severity::High,
                title: format!("Large withdrawal held: {amount} by {owner}"),
                detail: format!("hold {hold}, releases at unix {release_at}; guardian can freeze"),
                signature: ev.signature.clone(),
                dedupe_key: format!("hold:{hold}"),
            }],
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn held_withdrawal_pages_high() {
        let ev = Observed {
            signature: None,
            slot: 5,
            event: ChainEvent::LargeWithdrawalQueued { hold: "H".into(), owner: "O".into(), amount: 1_000, release_at: 99 },
        };
        let out = LargeWithdrawal.observe(&ev);
        assert_eq!(out[0].severity, Severity::High);
        assert_eq!(out[0].dedupe_key, "hold:H");
    }
}
