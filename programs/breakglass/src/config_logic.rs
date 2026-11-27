//! Config-change rules as pure functions, with unit tests. See docs/SPEC.md
//! (timelock row, "Step by step" E) and the Phase 4 decisions in PROGRESS.md.
//!
//! Loosening anything, or releasing funds, waits out `config.timelock_secs`
//! and can be vetoed by a guardian. Tightening a limiter applies at once.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, limiter::validate_params, state::*};

pub fn validate_limiter_params(p: &LimiterParams) -> Result<()> {
    validate_params(
        p.window_secs,
        p.cap_absolute,
        p.cap_bps_of_vault,
        p.large_threshold_bps,
        p.hold_secs,
        p.auto_trip_secs,
        p.screen_secs,
    )
}

/// A bps limit where 0 means "off" (the loosest setting).
fn bps_at_least_as_strict(old: u16, new: u16) -> bool {
    new == old || (new != 0 && (old == 0 || new <= old))
}

/// True if every field of `new` is equal to or stricter than `old`:
/// lower caps, thresholds and instant allowance; longer window, holds,
/// auto-trips and screening; a bps limit can be added or lowered, never removed.
pub fn is_tightening(old: &LimiterParams, new: &LimiterParams) -> bool {
    new.window_secs >= old.window_secs
        && new.cap_absolute <= old.cap_absolute
        && bps_at_least_as_strict(old.cap_bps_of_vault, new.cap_bps_of_vault)
        && new.large_threshold <= old.large_threshold
        && bps_at_least_as_strict(old.large_threshold_bps, new.large_threshold_bps)
        && new.hold_secs >= old.hold_secs
        && new.auto_trip_secs >= old.auto_trip_secs
        && new.instant_allowance <= old.instant_allowance
        && new.screen_secs >= old.screen_secs
}

impl FlowLimiter {
    pub fn params(&self) -> LimiterParams {
        LimiterParams {
            window_secs: self.window_secs,
            cap_absolute: self.cap_absolute,
            cap_bps_of_vault: self.cap_bps_of_vault,
            large_threshold: self.large_threshold,
            large_threshold_bps: self.large_threshold_bps,
            hold_secs: self.hold_secs,
            auto_trip_secs: self.auto_trip_secs,
            instant_allowance: self.instant_allowance,
            screen_secs: self.screen_secs,
        }
    }

    /// Apply new settings. If the window length changes, the bucket width
    /// changes too, so the current window total is folded into the newest
    /// bucket: it may over-count for one window, but never under-counts.
    pub fn apply_params(&mut self, p: &LimiterParams, now: i64) {
        if p.window_secs != self.window_secs {
            self.roll(now);
            let total = self.window_total();
            self.window_secs = p.window_secs;
            self.buckets = [0; LIMITER_BUCKETS];
            let width = self.bucket_width();
            self.bucket_start = now - now.rem_euclid(width);
            self.record(total);
        }
        self.cap_absolute = p.cap_absolute;
        self.cap_bps_of_vault = p.cap_bps_of_vault;
        self.large_threshold = p.large_threshold;
        self.large_threshold_bps = p.large_threshold_bps;
        self.hold_secs = p.hold_secs;
        self.auto_trip_secs = p.auto_trip_secs;
        self.instant_allowance = p.instant_allowance;
        self.screen_secs = p.screen_secs;
    }
}

pub fn validate_policy(policy: &PausePolicy, timelock_secs: i64) -> Result<()> {
    let ok = policy.max_guardian_pause_secs > 0
        && policy.cooldown_secs >= 0
        && policy.budget_secs_per_period > 0
        && policy.budget_period_secs > 0
        && policy.auto_trip_secs > 0;
    require!(ok, BreakglassError::InvalidPolicy);
    require!(
        (MIN_TIMELOCK_SECS..=MAX_TIMELOCK_SECS).contains(&timelock_secs),
        BreakglassError::InvalidTimelock
    );
    Ok(())
}

/// Checks that don't need extra accounts. Run at propose time (so bad
/// proposals fail early) and again at execute time (state may have changed).
pub fn validate_action(config: &ProtocolConfig, action: &ConfigAction) -> Result<()> {
    match action {
        ConfigAction::RaiseLimits { params, .. } => validate_limiter_params(params),
        ConfigAction::AddGuardian { guardian } => {
            require!(
                *guardian != Pubkey::default(),
                BreakglassError::WrongChangeAccounts
            );
            require!(
                !config.is_guardian(guardian),
                BreakglassError::DuplicateGuardian
            );
            require!(
                config.guardians.len() < MAX_GUARDIANS,
                BreakglassError::TooManyGuardians
            );
            Ok(())
        }
        ConfigAction::SetAdmin { admin } => {
            require!(
                *admin != Pubkey::default(),
                BreakglassError::WrongChangeAccounts
            );
            Ok(())
        }
        ConfigAction::ReleaseHeld { .. } => Ok(()),
        ConfigAction::ChangePolicy {
            policy,
            timelock_secs,
            ..
        } => validate_policy(policy, *timelock_secs),
    }
}

/// Whether a pending change can run at `now`. Order: closed, vetoed, timelock.
pub fn require_executable(change: &PendingConfig, now: i64) -> Result<()> {
    require!(
        !change.executed && !change.cancelled,
        BreakglassError::ChangeClosed
    );
    require!(!change.vetoed, BreakglassError::Vetoed);
    require!(now >= change.executable_at, BreakglassError::TimelockActive);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> LimiterParams {
        LimiterParams {
            window_secs: HOUR,
            cap_absolute: 1_000,
            cap_bps_of_vault: 500,
            large_threshold: 400,
            large_threshold_bps: 200,
            hold_secs: DEFAULT_HOLD_SECS,
            auto_trip_secs: HOUR,
            instant_allowance: 100,
            screen_secs: DEFAULT_SCREEN_SECS,
        }
    }

    #[test]
    fn same_settings_count_as_tightening() {
        assert!(is_tightening(&p(), &p()));
    }

    #[test]
    fn each_stricter_field_is_tightening() {
        let o = p();
        let cases = [
            LimiterParams {
                window_secs: 2 * HOUR,
                ..o
            },
            LimiterParams {
                cap_absolute: 999,
                ..o
            },
            LimiterParams {
                cap_bps_of_vault: 100,
                ..o
            },
            LimiterParams {
                large_threshold: 1,
                ..o
            },
            LimiterParams {
                large_threshold_bps: 1,
                ..o
            },
            LimiterParams {
                hold_secs: o.hold_secs + 1,
                ..o
            },
            LimiterParams {
                auto_trip_secs: o.auto_trip_secs + 1,
                ..o
            },
            LimiterParams {
                instant_allowance: 0,
                ..o
            },
            LimiterParams {
                screen_secs: o.screen_secs + 1,
                ..o
            },
        ];
        for c in cases {
            assert!(is_tightening(&o, &c), "{c:?}");
        }
    }

    #[test]
    fn each_looser_field_is_not_tightening() {
        let o = p();
        let cases = [
            LimiterParams {
                window_secs: HOUR - 1,
                ..o
            },
            LimiterParams {
                cap_absolute: 1_001,
                ..o
            },
            LimiterParams {
                cap_bps_of_vault: 501,
                ..o
            },
            LimiterParams {
                cap_bps_of_vault: 0,
                ..o
            }, // removing the bps cap
            LimiterParams {
                large_threshold: 401,
                ..o
            },
            LimiterParams {
                large_threshold_bps: 0,
                ..o
            },
            LimiterParams {
                hold_secs: o.hold_secs - 1,
                ..o
            },
            LimiterParams {
                auto_trip_secs: o.auto_trip_secs - 1,
                ..o
            },
            LimiterParams {
                instant_allowance: 101,
                ..o
            },
            LimiterParams {
                screen_secs: o.screen_secs - 1,
                ..o
            },
        ];
        for c in cases {
            assert!(!is_tightening(&o, &c), "{c:?}");
        }
    }

    #[test]
    fn adding_a_bps_limit_where_there_was_none_is_tightening() {
        let o = LimiterParams {
            cap_bps_of_vault: 0,
            large_threshold_bps: 0,
            ..p()
        };
        assert!(is_tightening(
            &o,
            &LimiterParams {
                cap_bps_of_vault: 10_000,
                ..o
            }
        ));
        assert!(is_tightening(
            &o,
            &LimiterParams {
                large_threshold_bps: 50,
                ..o
            }
        ));
    }

    #[test]
    fn a_mixed_change_is_not_tightening() {
        let o = p();
        let mixed = LimiterParams {
            cap_absolute: 10,
            hold_secs: 1,
            ..o
        };
        assert!(!is_tightening(&o, &mixed));
    }

    fn limiter(now: i64) -> FlowLimiter {
        let o = p();
        let mut l = FlowLimiter {
            bump: 0,
            config: Pubkey::default(),
            mint: Pubkey::default(),
            vault: Pubkey::default(),
            scope: 1,
            window_secs: o.window_secs,
            cap_absolute: o.cap_absolute,
            cap_bps_of_vault: o.cap_bps_of_vault,
            buckets: [0; LIMITER_BUCKETS],
            bucket_start: 0,
            large_threshold: o.large_threshold,
            large_threshold_bps: o.large_threshold_bps,
            hold_secs: o.hold_secs,
            auto_trip_secs: o.auto_trip_secs,
            instant_allowance: o.instant_allowance,
            screen_secs: o.screen_secs,
        };
        l.roll(now);
        l
    }

    #[test]
    fn params_round_trip() {
        let mut l = limiter(1_700_000_000);
        let n = LimiterParams {
            cap_absolute: 7,
            hold_secs: 9,
            ..p()
        };
        l.apply_params(&n, 1_700_000_000);
        assert_eq!(l.params(), n);
    }

    #[test]
    fn changing_the_window_keeps_the_counted_total() {
        let now = 1_700_000_000;
        let mut l = limiter(now);
        l.record(300);
        l.roll(now + 2_000);
        l.record(200);
        for w in [12, 600, DAY] {
            let mut c = l.clone();
            c.apply_params(
                &LimiterParams {
                    window_secs: w,
                    ..p()
                },
                now + 2_000,
            );
            assert_eq!(c.window_total(), 500, "window {w}");
            assert_eq!(c.window_secs, w);
        }
    }

    #[test]
    fn policy_and_timelock_are_validated() {
        let d = PausePolicy::default();
        assert!(validate_policy(&d, DEFAULT_TIMELOCK_SECS).is_ok());
        assert!(validate_policy(&d, MIN_TIMELOCK_SECS - 1).is_err());
        assert!(validate_policy(&d, MAX_TIMELOCK_SECS + 1).is_err());
        assert!(validate_policy(
            &PausePolicy {
                max_guardian_pause_secs: 0,
                ..d
            },
            DAY
        )
        .is_err());
        assert!(validate_policy(
            &PausePolicy {
                cooldown_secs: -1,
                ..d
            },
            DAY
        )
        .is_err());
        assert!(validate_policy(
            &PausePolicy {
                budget_period_secs: 0,
                ..d
            },
            DAY
        )
        .is_err());
        assert!(validate_policy(
            &PausePolicy {
                auto_trip_secs: 0,
                ..d
            },
            DAY
        )
        .is_err());
    }

    fn change(executable_at: i64) -> PendingConfig {
        PendingConfig {
            bump: 0,
            config: Pubkey::default(),
            id: 0,
            action: ConfigAction::SetAdmin {
                admin: Pubkey::new_unique(),
            },
            proposed_by: Pubkey::default(),
            proposed_at: 0,
            executable_at,
            vetoed: false,
            executed: false,
            cancelled: false,
        }
    }

    fn code(r: Result<()>) -> u32 {
        match r {
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an error, got {other:?}"),
        }
    }

    #[test]
    fn executable_only_after_the_timelock_and_never_when_closed_or_vetoed() {
        let is = |e: BreakglassError| 6000 + e as u32;
        assert_eq!(
            code(require_executable(&change(100), 99)),
            is(BreakglassError::TimelockActive)
        );
        assert!(require_executable(&change(100), 100).is_ok());
        let vetoed = PendingConfig {
            vetoed: true,
            ..change(100)
        };
        assert_eq!(
            code(require_executable(&vetoed, 1_000)),
            is(BreakglassError::Vetoed)
        );
        let done = PendingConfig {
            executed: true,
            ..change(100)
        };
        assert_eq!(
            code(require_executable(&done, 1_000)),
            is(BreakglassError::ChangeClosed)
        );
        let cancelled = PendingConfig {
            cancelled: true,
            vetoed: true,
            ..change(100)
        };
        assert_eq!(
            code(require_executable(&cancelled, 1_000)),
            is(BreakglassError::ChangeClosed)
        );
    }

    #[test]
    fn actions_are_validated() {
        let g = Pubkey::new_unique();
        let mut config = ProtocolConfig {
            version: 1,
            bump: 0,
            protected_program: Pubkey::default(),
            admin: Pubkey::new_unique(),
            guardians: vec![g],
            unpausable_mask: 0,
            policy: PausePolicy::default(),
            timelock_secs: DEFAULT_TIMELOCK_SECS,
            next_change_id: 0,
        };
        assert!(validate_action(
            &config,
            &ConfigAction::AddGuardian {
                guardian: Pubkey::new_unique()
            }
        )
        .is_ok());
        assert!(validate_action(&config, &ConfigAction::AddGuardian { guardian: g }).is_err());
        assert!(validate_action(
            &config,
            &ConfigAction::AddGuardian {
                guardian: Pubkey::default()
            }
        )
        .is_err());
        config.guardians = (0..MAX_GUARDIANS).map(|_| Pubkey::new_unique()).collect();
        assert!(validate_action(
            &config,
            &ConfigAction::AddGuardian {
                guardian: Pubkey::new_unique()
            }
        )
        .is_err());
        assert!(validate_action(
            &config,
            &ConfigAction::SetAdmin {
                admin: Pubkey::default()
            }
        )
        .is_err());
        let bad = LimiterParams {
            cap_absolute: 0,
            ..p()
        };
        assert!(validate_action(
            &config,
            &ConfigAction::RaiseLimits {
                mint: Pubkey::default(),
                params: bad
            }
        )
        .is_err());
        assert!(validate_action(
            &config,
            &ConfigAction::RaiseLimits {
                mint: Pubkey::default(),
                params: p()
            }
        )
        .is_ok());
    }
}
