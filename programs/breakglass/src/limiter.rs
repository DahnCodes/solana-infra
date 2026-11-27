//! Outflow limiter math as pure functions (no Clock, no accounts), with unit
//! and property tests. See docs/SPEC.md "Outflow limiter".
//!
//! Window: 12 buckets of width `ceil(window_secs / 11)`. The newest bucket is
//! partial, the other 11 are full, so the counted span is always at least
//! `window_secs`: the window may over-count by up to one bucket, never under.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, state::FlowLimiter};

/// `bps` of `balance`, rounded down, in u128 so `u64::MAX` can't overflow.
pub fn bps_of(balance: u64, bps: u16) -> u64 {
    ((balance as u128) * (bps as u128) / (BPS_DENOMINATOR as u128)) as u64
}

/// Validates limiter parameters (shared by `init_flow_limiter` and Phase 4 changes).
pub fn validate_params(
    window_secs: i64,
    cap_absolute: u64,
    cap_bps_of_vault: u16,
    large_threshold_bps: u16,
    hold_secs: i64,
    auto_trip_secs: i64,
    screen_secs: i64,
) -> Result<()> {
    let ok = window_secs >= LIMITER_BUCKETS as i64
        && cap_absolute > 0
        && cap_bps_of_vault as u64 <= BPS_DENOMINATOR
        && large_threshold_bps as u64 <= BPS_DENOMINATOR
        && hold_secs > 0
        && auto_trip_secs > 0
        && screen_secs > 0;
    require!(ok, BreakglassError::InvalidLimiterConfig);
    Ok(())
}

impl FlowLimiter {
    pub fn bucket_width(&self) -> i64 {
        let n = LIMITER_BUCKETS as i64 - 1;
        (self.window_secs + n - 1) / n
    }

    fn epoch(&self, t: i64) -> i64 {
        t.div_euclid(self.bucket_width())
    }

    fn index(epoch: i64) -> usize {
        epoch.rem_euclid(LIMITER_BUCKETS as i64) as usize
    }

    /// Zero the buckets that fell out of the window and move `bucket_start` to
    /// the bucket containing `now`. A clock that goes backwards changes nothing.
    pub fn roll(&mut self, now: i64) {
        let cur = self.epoch(now);
        let last = self.epoch(self.bucket_start);
        if cur <= last {
            return;
        }
        if cur - last >= LIMITER_BUCKETS as i64 {
            self.buckets = [0; LIMITER_BUCKETS];
        } else {
            for e in last + 1..=cur {
                self.buckets[Self::index(e)] = 0;
            }
        }
        self.bucket_start = cur * self.bucket_width();
    }

    /// Sum of all buckets (call `roll` first). Saturates at `u64::MAX`.
    pub fn window_total(&self) -> u64 {
        let sum: u128 = self.buckets.iter().map(|b| *b as u128).sum();
        sum.min(u64::MAX as u128) as u64
    }

    /// min(absolute cap, bps x vault balance). The cap shrinks as the vault drains.
    pub fn effective_cap(&self, vault_balance: u64) -> u64 {
        if self.cap_bps_of_vault == 0 {
            self.cap_absolute
        } else {
            self.cap_absolute
                .min(bps_of(vault_balance, self.cap_bps_of_vault))
        }
    }

    /// min(large_threshold, bps x vault balance) when the bps part is set.
    pub fn effective_threshold(&self, vault_balance: u64) -> u64 {
        if self.large_threshold_bps == 0 {
            self.large_threshold
        } else {
            self.large_threshold
                .min(bps_of(vault_balance, self.large_threshold_bps))
        }
    }

    /// Count `amount` in the current bucket (call `roll` first).
    pub fn record(&mut self, amount: u64) {
        let i = Self::index(self.epoch(self.bucket_start));
        self.buckets[i] = self.buckets[i].saturating_add(amount);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Recorded. `window_total` includes this amount.
    Allow { window_total: u64, window_cap: u64 },
    /// amount >= threshold. Not recorded (no funds move).
    HoldLarge,
    /// window_total + amount > cap. Not recorded; the caller auto-trips the scope.
    HoldBreach { window_total: u64, window_cap: u64 },
    /// amount > instant allowance (zero-loss screen-all). Not recorded.
    HoldScreen,
}

/// The outflow decision for one call (the pause check happens before this).
/// Order: large-withdrawal threshold, then the window cap, then screening.
/// `is_claim` is true for claims of held withdrawals: they already waited out
/// their hold, so they skip the threshold and screening, but still count
/// against the window (the cap holds even for held funds).
pub fn evaluate(
    limiter: &mut FlowLimiter,
    amount: u64,
    vault_balance: u64,
    now: i64,
    is_claim: bool,
) -> Verdict {
    limiter.roll(now);
    let window_total = limiter.window_total();
    let window_cap = limiter.effective_cap(vault_balance);
    if !is_claim && amount >= limiter.effective_threshold(vault_balance) {
        return Verdict::HoldLarge;
    }
    if (window_total as u128) + (amount as u128) > window_cap as u128 {
        return Verdict::HoldBreach {
            window_total,
            window_cap,
        };
    }
    if !is_claim && amount > limiter.instant_allowance {
        return Verdict::HoldScreen;
    }
    limiter.record(amount);
    Verdict::Allow {
        window_total: limiter.window_total(),
        window_cap,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::prelude::Pubkey;
    use proptest::prelude::*;

    fn limiter(window_secs: i64, cap: u64, threshold: u64, now: i64) -> FlowLimiter {
        let mut l = FlowLimiter {
            bump: 0,
            config: Pubkey::default(),
            mint: Pubkey::default(),
            vault: Pubkey::default(),
            scope: 1,
            window_secs,
            cap_absolute: cap,
            cap_bps_of_vault: 0,
            buckets: [0; LIMITER_BUCKETS],
            bucket_start: 0,
            large_threshold: threshold,
            large_threshold_bps: 0,
            hold_secs: DEFAULT_HOLD_SECS,
            auto_trip_secs: DEFAULT_AUTO_TRIP_SECS,
            instant_allowance: DEFAULT_INSTANT_ALLOWANCE,
            screen_secs: DEFAULT_SCREEN_SECS,
        };
        l.roll(now);
        l
    }

    const T0: i64 = 1_700_000_000;

    #[test]
    fn allow_records_and_reports_totals() {
        let mut l = limiter(HOUR, 1_000, 500, T0);
        assert_eq!(
            evaluate(&mut l, 300, 0, T0, false),
            Verdict::Allow {
                window_total: 300,
                window_cap: 1_000
            }
        );
        assert_eq!(
            evaluate(&mut l, 300, 0, T0 + 10, false),
            Verdict::Allow {
                window_total: 600,
                window_cap: 1_000
            }
        );
    }

    #[test]
    fn exactly_reaching_the_cap_is_allowed_crossing_it_holds() {
        let mut l = limiter(HOUR, 1_000, u64::MAX, T0);
        assert!(matches!(
            evaluate(&mut l, 1_000, 0, T0, false),
            Verdict::Allow { .. }
        ));
        assert_eq!(
            evaluate(&mut l, 1, 0, T0, false),
            Verdict::HoldBreach {
                window_total: 1_000,
                window_cap: 1_000
            }
        );
        // The breach was not recorded.
        assert_eq!(l.window_total(), 1_000);
    }

    #[test]
    fn large_is_held_before_and_without_counting() {
        let mut l = limiter(HOUR, 1_000, 400, T0);
        assert_eq!(evaluate(&mut l, 400, 0, T0, false), Verdict::HoldLarge);
        assert_eq!(l.window_total(), 0);
        // Claims skip the threshold but still count.
        assert!(matches!(
            evaluate(&mut l, 400, 0, T0, true),
            Verdict::Allow { .. }
        ));
        assert_eq!(l.window_total(), 400);
    }

    #[test]
    fn same_time_calls_all_count() {
        let mut l = limiter(HOUR, 1_000, u64::MAX, T0);
        for _ in 0..3 {
            assert!(matches!(
                evaluate(&mut l, 300, 0, T0, false),
                Verdict::Allow { .. }
            ));
        }
        assert!(matches!(
            evaluate(&mut l, 300, 0, T0, false),
            Verdict::HoldBreach { .. }
        ));
    }

    #[test]
    fn window_rolls_off_after_window_secs() {
        let mut l = limiter(HOUR, 1_000, u64::MAX, T0);
        evaluate(&mut l, 1_000, 0, T0, false);
        assert!(matches!(
            evaluate(&mut l, 1, 0, T0 + HOUR - 1, true),
            Verdict::HoldBreach { .. }
        ));
        // After 12 bucket widths (>= window) everything has rolled off.
        let later = T0 + 12 * l.bucket_width();
        assert!(matches!(
            evaluate(&mut l, 1_000, 0, later, false),
            Verdict::Allow { .. }
        ));
    }

    #[test]
    fn screen_all_holds_everything_but_breach_still_trips() {
        let mut l = limiter(HOUR, 1_000, 400, T0);
        l.instant_allowance = 0;
        assert_eq!(evaluate(&mut l, 1, 0, T0, false), Verdict::HoldScreen);
        assert_eq!(l.window_total(), 0);
        l.instant_allowance = 100;
        assert!(matches!(
            evaluate(&mut l, 100, 0, T0, false),
            Verdict::Allow { .. }
        ));
        assert_eq!(evaluate(&mut l, 101, 0, T0, false), Verdict::HoldScreen);
        // Large wins over screening; a breach wins over screening.
        assert_eq!(evaluate(&mut l, 400, 0, T0, false), Verdict::HoldLarge);
        l.cap_absolute = 150;
        assert!(matches!(
            evaluate(&mut l, 101, 0, T0, false),
            Verdict::HoldBreach { .. }
        ));
        // Claims skip screening.
        assert!(matches!(
            evaluate(&mut l, 50, 0, T0, true),
            Verdict::Allow { .. }
        ));
    }

    #[test]
    fn bucket_width_covers_the_window() {
        for w in [12, 13, 60, 600, 3_599, HOUR, DAY] {
            let l = limiter(w, 1, 1, T0);
            assert!(l.bucket_width() * 11 >= w, "window {w}");
        }
        assert_eq!(limiter(HOUR, 1, 1, T0).bucket_width(), 328);
    }

    #[test]
    fn bps_cap_shrinks_with_the_vault() {
        let mut l = limiter(HOUR, 1_000_000, u64::MAX, T0);
        l.cap_bps_of_vault = 1_000; // 10%
        assert_eq!(l.effective_cap(5_000_000), 500_000);
        assert_eq!(l.effective_cap(50_000_000), 1_000_000);
        assert_eq!(l.effective_cap(0), 0);
        l.large_threshold = 10_000;
        l.large_threshold_bps = 200; // 2%
        assert_eq!(l.effective_threshold(100_000), 2_000);
        assert_eq!(l.effective_threshold(10_000_000), 10_000);
    }

    #[test]
    fn clock_going_backwards_changes_nothing() {
        let mut l = limiter(HOUR, 1_000, u64::MAX, T0);
        evaluate(&mut l, 500, 0, T0, false);
        let before = l.buckets;
        l.roll(T0 - 10_000);
        assert_eq!(l.buckets, before);
    }

    #[test]
    fn params_are_validated() {
        let ok = |w, cap, bps, tbps, hold, trip, screen| {
            validate_params(w, cap, bps, tbps, hold, trip, screen).is_ok()
        };
        assert!(ok(HOUR, 1, 10_000, 10_000, 1, 1, 1));
        assert!(!ok(11, 1, 0, 0, 1, 1, 1));
        assert!(!ok(HOUR, 0, 0, 0, 1, 1, 1));
        assert!(!ok(HOUR, 1, 10_001, 0, 1, 1, 1));
        assert!(!ok(HOUR, 1, 0, 10_001, 1, 1, 1));
        assert!(!ok(HOUR, 1, 0, 0, 0, 1, 1));
        assert!(!ok(HOUR, 1, 0, 0, 1, 0, 1));
        assert!(!ok(HOUR, 1, 0, 0, 1, 1, 0));
    }

    /// (seconds since last call, amount)
    fn calls() -> impl Strategy<Value = Vec<(i64, u64)>> {
        prop::collection::vec((0i64..2_000, any::<u64>()), 1..80)
    }

    proptest! {
        /// The counted total is never below the true sum of allowed outflows
        /// in the last `window_secs`.
        #[test]
        fn window_never_under_counts(
            window in 12i64..20_000,
            cap in any::<u64>(),
            steps in calls(),
            small in any::<bool>(),
        ) {
            let mut l = limiter(window, cap, u64::MAX, T0);
            let mut now = T0;
            let mut allowed: Vec<(i64, u64)> = vec![];
            for (dt, amt) in steps {
                now += dt;
                let amt = if small { amt % 1_000 } else { amt };
                if let Verdict::Allow { window_total, .. } = evaluate(&mut l, amt, 0, now, false) {
                    allowed.push((now, amt));
                    let truth: u128 = allowed.iter()
                        .filter(|(t, _)| *t > now - window)
                        .map(|(_, a)| *a as u128).sum();
                    prop_assert!(window_total as u128 >= truth.min(u64::MAX as u128));
                }
                l.roll(now);
                let truth: u128 = allowed.iter()
                    .filter(|(t, _)| *t > now - window)
                    .map(|(_, a)| *a as u128).sum();
                prop_assert!(l.window_total() as u128 >= truth.min(u64::MAX as u128));
            }
        }

        /// Every call that would push the window past the cap is held, and an
        /// allowed call never leaves the window above the cap.
        #[test]
        fn cap_breach_always_holds(
            window in 12i64..20_000,
            cap in 0u64..1_000_000,
            steps in prop::collection::vec((0i64..500, 0u64..400_000), 1..80),
            bps in 0u16..=10_000,
            balance in any::<u64>(),
        ) {
            let mut l = limiter(window, cap, u64::MAX, T0);
            l.cap_bps_of_vault = bps;
            let mut now = T0;
            for (dt, amt) in steps {
                now += dt;
                l.roll(now);
                let before = l.window_total() as u128;
                let eff = l.effective_cap(balance) as u128;
                match evaluate(&mut l, amt, balance, now, false) {
                    Verdict::Allow { window_total, window_cap } => {
                        prop_assert!(before + amt as u128 <= eff);
                        prop_assert!(window_total as u128 <= window_cap as u128);
                    }
                    Verdict::HoldBreach { .. } => prop_assert!(before + amt as u128 > eff),
                    Verdict::HoldLarge | Verdict::HoldScreen => {
                        prop_assert!(false, "threshold and allowance are u64::MAX")
                    }
                }
            }
        }

        /// No panics or overflow anywhere at extreme values.
        #[test]
        fn no_overflow_at_extremes(
            amt in prop::sample::select(vec![0, 1, u64::MAX / 2, u64::MAX - 1, u64::MAX]),
            balance in prop::sample::select(vec![0, 1, u64::MAX]),
            bps in prop::sample::select(vec![0u16, 1, 9_999, 10_000]),
            cap in prop::sample::select(vec![1, u64::MAX]),
            now in prop::sample::select(vec![0i64, 1, T0, i64::MAX / 2]),
            window in prop::sample::select(vec![12i64, HOUR, i64::MAX / 4]),
            repeats in 1usize..5,
        ) {
            let mut l = limiter(window, cap, u64::MAX, now);
            l.cap_bps_of_vault = bps;
            l.large_threshold_bps = bps;
            for _ in 0..repeats {
                evaluate(&mut l, amt, balance, now, true);
                evaluate(&mut l, amt, balance, now, false);
                l.record(amt);
            }
            let _ = l.window_total();
            let _ = l.effective_threshold(balance);
        }
    }
}
