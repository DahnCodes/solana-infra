use std::collections::{BTreeMap, HashMap, HashSet};

use super::{hold_request, Detector};
use crate::decode::BgEvent;
use crate::event::{ChainEvent, Observed, Severity, Signal, Subject};

const HOUR: i64 = 3_600;
const WINDOW_HOURS: i64 = 30 * 24;

/// High when a mint's requested outflow this hour exceeds its 30-day hourly
/// mean by more than `sigma` standard deviations (hours with no outflow count
/// as zero). Requested outflow = allowed withdrawals + newly held ones (claims
/// aren't counted again). Needs `min_hours` of history before it judges.
/// Held withdrawals queued in a flagged hour are flagged too (the bot freezes them).
pub struct VelocityBaseline {
    sigma: f64,
    min_hours: i64,
    hours: HashMap<String, BTreeMap<i64, u128>>,
    flagged: HashSet<(String, i64)>,
    /// Signatures of claim transactions (HoldResolved 0 precedes their OutflowRecorded).
    claim_sigs: HashSet<String>,
}

impl VelocityBaseline {
    pub fn new(sigma: f64, min_hours: u64) -> Self {
        Self {
            sigma,
            min_hours: min_hours as i64,
            hours: HashMap::new(),
            flagged: HashSet::new(),
            claim_sigs: HashSet::new(),
        }
    }

    /// Seed hourly totals from the store: (mint, hour start, amount).
    pub fn seed(&mut self, rows: Vec<(String, i64, u128)>) {
        for (mint, hour, amount) in rows {
            *self.hours.entry(mint).or_default().entry(hour).or_default() += amount;
        }
    }

    /// (mean, std dev, hours) of the full hours before `hour`, zeros included.
    fn baseline(&self, mint: &str, hour: i64) -> Option<(f64, f64, i64)> {
        let h = self.hours.get(mint)?;
        let first = *h.keys().next()?;
        let start = first.max(hour - WINDOW_HOURS * HOUR);
        let n = (hour - start) / HOUR;
        if n < self.min_hours {
            return None;
        }
        let vals: Vec<f64> = (0..n)
            .map(|k| *h.get(&(start + k * HOUR)).unwrap_or(&0) as f64)
            .collect();
        let mean = vals.iter().sum::<f64>() / n as f64;
        let var = vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
        Some((mean, var.sqrt(), n))
    }

    fn add(&mut self, mint: &str, amount: u64, at: i64) -> (i64, u128) {
        let hour = at - at.rem_euclid(HOUR);
        let h = self.hours.entry(mint.to_string()).or_default();
        *h.entry(hour).or_default() += amount as u128;
        let cutoff = hour - (WINDOW_HOURS + 1) * HOUR;
        h.retain(|k, _| *k >= cutoff);
        (hour, h[&hour])
    }
}

impl Detector for VelocityBaseline {
    fn name(&self) -> &'static str {
        "velocity_baseline"
    }

    fn observe(&mut self, ev: &Observed) -> Vec<Signal> {
        let ChainEvent::Breakglass(e) = &ev.event else {
            return vec![];
        };
        let sig = ev.signature.clone().unwrap_or_default();
        let (mint, amount, hold, owner) = match e {
            BgEvent::HoldResolved(r) if r.outcome == 0 => {
                self.claim_sigs.insert(sig);
                return vec![];
            }
            BgEvent::OutflowRecorded(o) if !self.claim_sigs.contains(&sig) => {
                (o.mint.to_string(), o.amount.0, None, o.owner.to_string())
            }
            e => match hold_request(e) {
                Some(h) => (h.mint, h.amount, Some(h.hold), h.owner),
                None => return vec![],
            },
        };
        let (hour, total) = self.add(&mint, amount, ev.received_at);
        let Some((mean, sd, n)) = self.baseline(&mint, hour) else {
            return vec![];
        };
        let limit = mean + self.sigma * sd;
        if (total as f64) <= limit {
            return vec![];
        }
        let first_in_hour = self.flagged.insert((mint.clone(), hour));
        if !first_in_hour && hold.is_none() {
            return vec![];
        }
        vec![Signal {
            detector: "velocity_baseline",
            severity: Severity::High,
            title: format!("Abnormal outflow velocity for mint {mint}: {total} this hour"),
            detail: format!("30-day hourly mean {mean:.0}, std dev {sd:.0} over {n}h; limit {limit:.0} ({}σ)", self.sigma),
            actions: "Guardian bot freezes withdrawals held this hour. Investigate; pause if it's an exploit.".into(),
            signature: ev.signature.clone(),
            dedupe_key: match &hold {
                Some(h) => format!("velocity:{h}"),
                None => format!("velocity:{mint}:{hour}"),
            },
            subject: Subject { hold, owner: Some(owner), mint: Some(mint) },
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::*;
    use crate::detectors::fixtures::*;

    const T: i64 = 1_800_000_000 - 1_800_000_000 % HOUR;

    fn outflow(amount: u64, at: i64, sig: &str) -> Observed {
        let mut o = bg(
            BgEvent::OutflowRecorded(OutflowRecorded {
                config: pk(1),
                mint: pk(2),
                owner: pk(3),
                amount: u(amount),
                window_total: u(0),
                window_cap: u(1),
            }),
            at,
        );
        o.signature = Some(sig.into());
        o
    }

    fn seeded() -> VelocityBaseline {
        let mut d = VelocityBaseline::new(4.0, 24);
        // 48 hours of 90..110 per hour.
        let rows = (0..48)
            .map(|k| {
                (
                    pk(2).to_string(),
                    T - (48 - k) * HOUR,
                    (90 + (k % 3) * 10) as u128,
                )
            })
            .collect();
        d.seed(rows);
        d
    }

    #[test]
    fn normal_volume_is_quiet_and_a_spike_is_high_once_per_hour() {
        let mut d = seeded();
        assert!(d.observe(&outflow(100, T + 10, "a")).is_empty());
        let out = d.observe(&outflow(1_000, T + 20, "b"));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].severity, Severity::High);
        assert!(
            d.observe(&outflow(1_000, T + 30, "c")).is_empty(),
            "once per hour"
        );
    }

    #[test]
    fn holds_count_and_are_flagged_individually_in_a_hot_hour() {
        let mut d = seeded();
        d.observe(&outflow(1_000, T + 20, "b"));
        let h = bg(
            BgEvent::WithdrawalScreenQueued(WithdrawalScreenQueued {
                config: pk(1),
                hold: pk(9),
                mint: pk(2),
                owner: pk(3),
                amount: u(10),
                release_at: i(0),
            }),
            T + 40,
        );
        let out = d.observe(&h);
        assert_eq!(out[0].subject.hold, Some(pk(9).to_string()));
    }

    #[test]
    fn claims_are_not_counted_twice() {
        let mut d = seeded();
        let mut r = bg(
            BgEvent::HoldResolved(HoldResolved {
                config: pk(1),
                hold: pk(9),
                outcome: 0,
            }),
            T + 5,
        );
        r.signature = Some("claim".into());
        d.observe(&r);
        assert!(d.observe(&outflow(100_000, T + 5, "claim")).is_empty());
    }

    #[test]
    fn needs_enough_history() {
        let mut d = VelocityBaseline::new(4.0, 24);
        d.seed(vec![(pk(2).to_string(), T - 5 * HOUR, 1)]);
        assert!(d.observe(&outflow(1_000_000, T, "x")).is_empty());
    }
}
