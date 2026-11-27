//! Pause rules as pure functions (no Clock, no accounts), so every griefing
//! limit is unit-tested here. The instruction handlers only load accounts,
//! call these, and emit events. See docs/SPEC.md "Roles and permissions" and
//! "Open design points", and the Phase 1 decisions in docs/PROGRESS.md.
//!
//! Model: `PauseState.active` holds one entry per (scope, kind, paused_by).
//! A scope is paused while any of its entries has `paused_until > now`.
//! Expired entries are pruned on every write.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, state::*};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Admin,
    Guardian,
}

/// Admin takes precedence if a key is both admin and guardian.
pub fn role_of(config: &ProtocolConfig, key: &Pubkey) -> Result<Role> {
    if *key == config.admin {
        Ok(Role::Admin)
    } else if config.is_guardian(key) {
        Ok(Role::Guardian)
    } else {
        err!(BreakglassError::Unauthorized)
    }
}

/// Scope ids set in `mask`, ascending.
pub fn scopes_in(mask: u64) -> impl Iterator<Item = u8> {
    (0..MAX_SCOPES).filter(move |s| mask & scope_bit(*s) != 0)
}

impl PauseState {
    pub fn prune_expired(&mut self, now: i64) {
        self.active.retain(|p| p.paused_until > now);
    }

    fn active_for(&self, scope: u8) -> impl Iterator<Item = &ScopePause> {
        self.active.iter().filter(move |p| p.scope == scope)
    }

    /// Add a pause, or extend the same party's existing entry. Never shortens.
    /// Returns the entry's resulting `paused_until`.
    pub fn upsert(
        &mut self,
        scope: u8,
        kind: PauseKind,
        by: Pubkey,
        until: i64,
        reason: u16,
        renewals: u8,
    ) -> Result<i64> {
        if let Some(p) = self
            .active
            .iter_mut()
            .find(|p| p.scope == scope && p.kind == kind && p.paused_by == by)
        {
            p.paused_until = p.paused_until.max(until);
            p.renewals = p.renewals.max(renewals);
            return Ok(p.paused_until);
        }
        require!(
            self.active.len() < MAX_ACTIVE_PAUSES,
            BreakglassError::TooManyActivePauses
        );
        self.active.push(ScopePause {
            scope,
            paused_until: until,
            paused_by: by,
            kind,
            renewals,
            reason,
        });
        Ok(until)
    }
}

impl GuardianLedger {
    /// Fill a ledger that `init_if_needed` just created (all zeroes).
    pub fn init_if_new(&mut self, bump: u8, config: Pubkey, guardian: Pubkey, now: i64) {
        if self.guardian == Pubkey::default() {
            self.bump = bump;
            self.config = config;
            self.guardian = guardian;
            self.period_start = now;
            self.pause_secs_used = 0;
            self.last_pause_end = 0;
        }
    }

    /// Start a fresh budget period once the current one is over.
    pub fn roll_period(&mut self, policy: &PausePolicy, now: i64) {
        if now >= self.period_start.saturating_add(policy.budget_period_secs) {
            self.period_start = now;
            self.pause_secs_used = 0;
        }
    }

    /// No new pause while one of this guardian's pauses is running, or within
    /// `cooldown_secs` of its scheduled end.
    pub fn require_off_cooldown(&self, policy: &PausePolicy, now: i64) -> Result<()> {
        require!(
            now >= self.last_pause_end.saturating_add(policy.cooldown_secs),
            BreakglassError::GuardianCooldown
        );
        Ok(())
    }

    /// Spend `secs` of the period budget, or fail without spending.
    pub fn charge(&mut self, policy: &PausePolicy, secs: i64) -> Result<()> {
        let used = self
            .pause_secs_used
            .checked_add(secs)
            .ok_or(BreakglassError::MathOverflow)?;
        require!(
            used <= policy.budget_secs_per_period,
            BreakglassError::PauseBudgetExhausted
        );
        self.pause_secs_used = used;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PauseOutcome {
    pub paused_until: i64,
    pub kind: PauseKind,
}

/// `pause(scopes, duration, reason)`. `ledger` is the signer's GuardianLedger
/// (it is only read and charged when the signer is a guardian).
#[allow(clippy::too_many_arguments)]
pub fn apply_pause(
    state: &mut PauseState,
    ledger: &mut GuardianLedger,
    config: &ProtocolConfig,
    by: Pubkey,
    mask: u64,
    duration: i64,
    reason: u16,
    now: i64,
) -> Result<PauseOutcome> {
    let role = role_of(config, &by)?;
    require!(mask != 0, BreakglassError::InvalidScope);
    require!(
        mask & config.unpausable_mask == 0,
        BreakglassError::ScopeUnpausable
    );
    require!(duration > 0, BreakglassError::InvalidDuration);
    let until = now
        .checked_add(duration)
        .ok_or(BreakglassError::MathOverflow)?;
    let policy = &config.policy;

    let kind = match role {
        Role::Guardian => {
            require!(
                duration <= policy.max_guardian_pause_secs,
                BreakglassError::PauseTooLong
            );
            ledger.roll_period(policy, now);
            ledger.require_off_cooldown(policy, now)?;
            ledger.charge(policy, duration)?;
            ledger.last_pause_end = ledger.last_pause_end.max(until);
            PauseKind::Guardian
        }
        Role::Admin => PauseKind::Admin,
    };

    state.prune_expired(now);
    let mut paused_until = until;
    for scope in scopes_in(mask) {
        paused_until = paused_until.max(state.upsert(scope, kind, by, until, reason, 0)?);
    }
    Ok(PauseOutcome { paused_until, kind })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenewOutcome {
    pub paused_until: i64,
    pub renewals: u8,
}

/// `renew_pause(scopes)`: extends by `policy.max_guardian_pause_secs`.
/// - Guardian: only its own running pauses, at most `max_renewals` times each,
///   charged to its budget.
/// - Admin: any running pause, no cap. The extension is recorded as an Admin
///   entry, so only the admin can lift it.
pub fn apply_renew(
    state: &mut PauseState,
    ledger: &mut GuardianLedger,
    config: &ProtocolConfig,
    by: Pubkey,
    mask: u64,
    now: i64,
) -> Result<RenewOutcome> {
    let role = role_of(config, &by)?;
    require!(mask != 0, BreakglassError::InvalidScope);
    let policy = &config.policy;
    let ext = policy.max_guardian_pause_secs;
    state.prune_expired(now);

    let mut out = RenewOutcome {
        paused_until: 0,
        renewals: 0,
    };
    match role {
        Role::Guardian => {
            let own = |p: &ScopePause| p.kind == PauseKind::Guardian && p.paused_by == by;
            for scope in scopes_in(mask) {
                match state.active_for(scope).find(|p| own(p)) {
                    Some(p) => require!(
                        p.renewals < policy.max_renewals,
                        BreakglassError::RenewCapReached
                    ),
                    None if state.active_for(scope).next().is_some() => {
                        return err!(BreakglassError::Unauthorized)
                    }
                    None => return err!(BreakglassError::ScopeNotPaused),
                }
            }
            ledger.roll_period(policy, now);
            ledger.charge(policy, ext)?;
            for p in state
                .active
                .iter_mut()
                .filter(|p| mask & scope_bit(p.scope) != 0 && own(p))
            {
                p.paused_until = p
                    .paused_until
                    .checked_add(ext)
                    .ok_or(BreakglassError::MathOverflow)?;
                p.renewals = p.renewals.saturating_add(1);
                out.paused_until = out.paused_until.max(p.paused_until);
                out.renewals = out.renewals.max(p.renewals);
            }
            ledger.last_pause_end = ledger.last_pause_end.max(out.paused_until);
        }
        Role::Admin => {
            for scope in scopes_in(mask) {
                let longest = state
                    .active_for(scope)
                    .max_by_key(|p| p.paused_until)
                    .copied()
                    .ok_or(BreakglassError::ScopeNotPaused)?;
                let renewals = state
                    .active_for(scope)
                    .map(|p| p.renewals)
                    .max()
                    .unwrap_or(0)
                    .saturating_add(1);
                let until = longest
                    .paused_until
                    .checked_add(ext)
                    .ok_or(BreakglassError::MathOverflow)?;
                let until =
                    state.upsert(scope, PauseKind::Admin, by, until, longest.reason, renewals)?;
                out.paused_until = out.paused_until.max(until);
                out.renewals = out.renewals.max(renewals);
            }
        }
    }
    Ok(out)
}

/// `unpause(scopes)`. Returns the mask of scopes actually lifted.
/// - Admin: lifts every running pause on the scopes (guardian, auto-trip, admin).
/// - Guardian: only scopes whose running pauses are all its own. Any other
///   party's pause on a requested scope fails the whole call with Unauthorized.
///
/// Scopes in the mask that aren't paused are skipped. If nothing was lifted,
/// the call fails with ScopeNotPaused.
pub fn apply_unpause(
    state: &mut PauseState,
    config: &ProtocolConfig,
    by: Pubkey,
    mask: u64,
    now: i64,
) -> Result<u64> {
    let role = role_of(config, &by)?;
    require!(mask != 0, BreakglassError::InvalidScope);
    state.prune_expired(now);

    if role == Role::Guardian {
        for scope in scopes_in(mask) {
            require!(
                state
                    .active_for(scope)
                    .all(|p| p.kind == PauseKind::Guardian && p.paused_by == by),
                BreakglassError::Unauthorized
            );
        }
    }

    let mut lifted = 0u64;
    state.active.retain(|p| {
        let hit = mask & scope_bit(p.scope) != 0;
        if hit {
            lifted |= scope_bit(p.scope);
        }
        !hit
    });
    require!(lifted != 0, BreakglassError::ScopeNotPaused);
    Ok(lifted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::scopes::*;

    const NOW: i64 = 1_700_000_000;

    struct Fx {
        config: ProtocolConfig,
        state: PauseState,
        admin: Pubkey,
        g1: Pubkey,
        g2: Pubkey,
        l1: GuardianLedger,
        l2: GuardianLedger,
        ladmin: GuardianLedger,
    }

    fn ledger(g: Pubkey) -> GuardianLedger {
        let mut l = GuardianLedger {
            bump: 0,
            config: Pubkey::default(),
            guardian: Pubkey::default(),
            period_start: 0,
            pause_secs_used: 0,
            last_pause_end: 0,
        };
        l.init_if_new(1, Pubkey::new_unique(), g, NOW);
        l
    }

    fn fx() -> Fx {
        let admin = Pubkey::new_unique();
        let g1 = Pubkey::new_unique();
        let g2 = Pubkey::new_unique();
        Fx {
            config: ProtocolConfig {
                version: 1,
                bump: 0,
                protected_program: Pubkey::new_unique(),
                admin,
                guardians: vec![g1, g2],
                unpausable_mask: scope_bit(REPAY),
                policy: PausePolicy::default(),
                timelock_secs: DEFAULT_TIMELOCK_SECS,
                next_change_id: 0,
            },
            state: PauseState {
                bump: 0,
                config: Pubkey::default(),
                active: vec![],
            },
            admin,
            g1,
            g2,
            l1: ledger(g1),
            l2: ledger(g2),
            ladmin: ledger(admin),
        }
    }

    fn code(r: Result<impl std::fmt::Debug>) -> u32 {
        match r {
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an error, got {other:?}"),
        }
    }

    fn is(e: BreakglassError) -> u32 {
        6000 + e as u32
    }

    const W: u64 = 1 << WITHDRAW;
    const D: u64 = 1 << DEPOSIT;

    #[test]
    fn roles() {
        let f = fx();
        assert_eq!(role_of(&f.config, &f.admin).unwrap(), Role::Admin);
        assert_eq!(role_of(&f.config, &f.g1).unwrap(), Role::Guardian);
        assert_eq!(
            code(role_of(&f.config, &Pubkey::new_unique())),
            is(BreakglassError::Unauthorized)
        );
    }

    #[test]
    fn guardian_pause_blocks_then_expires_lazily() {
        let mut f = fx();
        let out = apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 100, 7, NOW).unwrap();
        assert_eq!(out.paused_until, NOW + 100);
        assert_eq!(out.kind, PauseKind::Guardian);
        assert!(f.state.is_paused(WITHDRAW, NOW + 99));
        assert!(!f.state.is_paused(WITHDRAW, NOW + 100));
        assert!(!f.state.is_paused(DEPOSIT, NOW));
        assert_eq!(f.l1.pause_secs_used, 100);
        assert_eq!(f.l1.last_pause_end, NOW + 100);
    }

    #[test]
    fn guardian_max_duration() {
        let mut f = fx();
        let max = f.config.policy.max_guardian_pause_secs;
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                max + 1,
                0,
                NOW
            )),
            is(BreakglassError::PauseTooLong)
        );
        assert!(f.state.active.is_empty());
        assert_eq!(f.l1.pause_secs_used, 0);
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, max, 0, NOW).unwrap();
    }

    #[test]
    fn admin_has_no_duration_cap_and_no_ledger_charge() {
        let mut f = fx();
        let out = apply_pause(
            &mut f.state,
            &mut f.ladmin,
            &f.config,
            f.admin,
            W,
            30 * DAY,
            0,
            NOW,
        )
        .unwrap();
        assert_eq!(out.kind, PauseKind::Admin);
        assert_eq!(f.ladmin.pause_secs_used, 0);
        assert_eq!(f.ladmin.last_pause_end, 0);
    }

    #[test]
    fn bad_inputs() {
        let mut f = fx();
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                0,
                10,
                0,
                NOW
            )),
            is(BreakglassError::InvalidScope)
        );
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                0,
                0,
                NOW
            )),
            is(BreakglassError::InvalidDuration)
        );
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                -5,
                0,
                NOW
            )),
            is(BreakglassError::InvalidDuration)
        );
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.ladmin,
                &f.config,
                f.admin,
                W,
                i64::MAX,
                0,
                NOW
            )),
            is(BreakglassError::MathOverflow)
        );
        let stranger = Pubkey::new_unique();
        let mut ls = ledger(stranger);
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut ls,
                &f.config,
                stranger,
                W,
                10,
                0,
                NOW
            )),
            is(BreakglassError::Unauthorized)
        );
    }

    #[test]
    fn unpausable_scopes_never_pause() {
        let mut f = fx();
        let r = 1 << REPAY;
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                r,
                10,
                0,
                NOW
            )),
            is(BreakglassError::ScopeUnpausable)
        );
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.ladmin,
                &f.config,
                f.admin,
                r | W,
                10,
                0,
                NOW
            )),
            is(BreakglassError::ScopeUnpausable)
        );
        assert!(f.state.active.is_empty());
    }

    #[test]
    fn cooldown_runs_from_scheduled_end() {
        let mut f = fx();
        let cd = f.config.policy.cooldown_secs;
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 100, 0, NOW).unwrap();
        // While running, and for cooldown after the end: blocked, on any scope.
        for t in [NOW + 1, NOW + 100, NOW + 100 + cd - 1] {
            assert_eq!(
                code(apply_pause(
                    &mut f.state,
                    &mut f.l1,
                    &f.config,
                    f.g1,
                    D,
                    10,
                    0,
                    t
                )),
                is(BreakglassError::GuardianCooldown)
            );
        }
        // Lifting early gives no cooldown credit.
        apply_unpause(&mut f.state, &f.config, f.g1, W, NOW + 1).unwrap();
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                D,
                10,
                0,
                NOW + 2
            )),
            is(BreakglassError::GuardianCooldown)
        );
        apply_pause(
            &mut f.state,
            &mut f.l1,
            &f.config,
            f.g1,
            D,
            10,
            0,
            NOW + 100 + cd,
        )
        .unwrap();
        // Cooldown is per guardian.
        apply_pause(&mut f.state, &mut f.l2, &f.config, f.g2, W, 10, 0, NOW + 1).unwrap();
    }

    #[test]
    fn budget_is_per_period_and_rolls_over() {
        let mut f = fx();
        let p = f.config.policy;
        let step = p.max_guardian_pause_secs + p.cooldown_secs;
        let mut t = NOW;
        // 96h budget = four full 24h pauses.
        for _ in 0..4 {
            apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                p.max_guardian_pause_secs,
                0,
                t,
            )
            .unwrap();
            t += step;
        }
        assert_eq!(f.l1.pause_secs_used, p.budget_secs_per_period);
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                1,
                0,
                t
            )),
            is(BreakglassError::PauseBudgetExhausted)
        );
        // Failed call spent nothing and didn't move the cooldown.
        assert_eq!(f.l1.pause_secs_used, p.budget_secs_per_period);
        // Next period: budget is back.
        let next = f.l1.period_start + p.budget_period_secs;
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 10, 0, next).unwrap();
        assert_eq!(f.l1.period_start, next);
        assert_eq!(f.l1.pause_secs_used, 10);
    }

    #[test]
    fn guardian_renews_twice_then_admin_only() {
        let mut f = fx();
        let ext = f.config.policy.max_guardian_pause_secs;
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 100, 0, NOW).unwrap();
        let r1 = apply_renew(&mut f.state, &mut f.l1, &f.config, f.g1, W, NOW + 1).unwrap();
        assert_eq!(
            r1,
            RenewOutcome {
                paused_until: NOW + 100 + ext,
                renewals: 1
            }
        );
        let r2 = apply_renew(&mut f.state, &mut f.l1, &f.config, f.g1, W, NOW + 2).unwrap();
        assert_eq!(r2.renewals, 2);
        assert_eq!(f.l1.last_pause_end, NOW + 100 + 2 * ext);
        assert_eq!(f.l1.pause_secs_used, 100 + 2 * ext);
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                NOW + 3
            )),
            is(BreakglassError::RenewCapReached)
        );
        // Admin extends past the cap; the extension is an admin entry.
        let ra = apply_renew(&mut f.state, &mut f.ladmin, &f.config, f.admin, W, NOW + 4).unwrap();
        assert_eq!(ra.paused_until, NOW + 100 + 3 * ext);
        assert_eq!(ra.renewals, 3);
        // So the guardian can no longer lift the scope.
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g1, W, NOW + 5)),
            is(BreakglassError::Unauthorized)
        );
        assert!(f.state.is_paused(WITHDRAW, NOW + 100 + 3 * ext - 1));
    }

    #[test]
    fn renew_needs_a_running_pause_of_ones_own() {
        let mut f = fx();
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                NOW
            )),
            is(BreakglassError::ScopeNotPaused)
        );
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.ladmin,
                &f.config,
                f.admin,
                W,
                NOW
            )),
            is(BreakglassError::ScopeNotPaused)
        );
        apply_pause(&mut f.state, &mut f.l2, &f.config, f.g2, W, 100, 0, NOW).unwrap();
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                NOW
            )),
            is(BreakglassError::Unauthorized)
        );
        // Expired pauses can't be renewed.
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.l2,
                &f.config,
                f.g2,
                W,
                NOW + 100
            )),
            is(BreakglassError::ScopeNotPaused)
        );
    }

    #[test]
    fn renew_charges_the_budget() {
        let mut f = fx();
        f.config.policy.budget_secs_per_period = f.config.policy.max_guardian_pause_secs;
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 100, 0, NOW).unwrap();
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                NOW + 1
            )),
            is(BreakglassError::PauseBudgetExhausted)
        );
        assert_eq!(f.state.active[0].renewals, 0);
        assert_eq!(f.state.active[0].paused_until, NOW + 100);
    }

    #[test]
    fn guardian_lifts_only_its_own_pause() {
        let mut f = fx();
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W | D, 100, 0, NOW).unwrap();
        // Another guardian can't lift it.
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g2, W, NOW)),
            is(BreakglassError::Unauthorized)
        );
        assert_eq!(
            apply_unpause(&mut f.state, &f.config, f.g1, W, NOW).unwrap(),
            W
        );
        assert!(!f.state.is_paused(WITHDRAW, NOW));
        assert!(f.state.is_paused(DEPOSIT, NOW));
    }

    #[test]
    fn guardian_cannot_lift_admin_or_auto_trip() {
        let mut f = fx();
        apply_pause(
            &mut f.state,
            &mut f.ladmin,
            &f.config,
            f.admin,
            W,
            100,
            0,
            NOW,
        )
        .unwrap();
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g1, W, NOW)),
            is(BreakglassError::Unauthorized)
        );
        // Guardian adds its own pause on top: still can't lift the scope.
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 50, 0, NOW).unwrap();
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g1, W, NOW)),
            is(BreakglassError::Unauthorized)
        );
        f.state
            .upsert(
                DEPOSIT,
                PauseKind::AutoTrip,
                Pubkey::new_unique(),
                NOW + 100,
                0,
                0,
            )
            .unwrap();
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g1, D, NOW)),
            is(BreakglassError::Unauthorized)
        );
        // Admin lifts everything.
        assert_eq!(
            apply_unpause(&mut f.state, &f.config, f.admin, W | D, NOW).unwrap(),
            W | D
        );
        assert!(f.state.active.is_empty());
    }

    #[test]
    fn unpause_of_nothing_fails() {
        let mut f = fx();
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.admin, W, NOW)),
            is(BreakglassError::ScopeNotPaused)
        );
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 100, 0, NOW).unwrap();
        // Expired counts as not paused.
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g1, W, NOW + 100)),
            is(BreakglassError::ScopeNotPaused)
        );
        let stranger = Pubkey::new_unique();
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, stranger, W, NOW)),
            is(BreakglassError::Unauthorized)
        );
    }

    #[test]
    fn admin_repause_never_shortens() {
        let mut f = fx();
        apply_pause(
            &mut f.state,
            &mut f.ladmin,
            &f.config,
            f.admin,
            W,
            1_000,
            0,
            NOW,
        )
        .unwrap();
        let out = apply_pause(
            &mut f.state,
            &mut f.ladmin,
            &f.config,
            f.admin,
            W,
            10,
            0,
            NOW,
        )
        .unwrap();
        assert_eq!(out.paused_until, NOW + 1_000);
        assert_eq!(f.state.active.len(), 1);
    }

    #[test]
    fn removed_guardian_loses_all_powers() {
        let mut f = fx();
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 100, 0, NOW).unwrap();
        f.config.guardians.retain(|g| *g != f.g1);
        assert_eq!(
            code(apply_unpause(&mut f.state, &f.config, f.g1, W, NOW)),
            is(BreakglassError::Unauthorized)
        );
        assert_eq!(
            code(apply_renew(
                &mut f.state,
                &mut f.l1,
                &f.config,
                f.g1,
                W,
                NOW
            )),
            is(BreakglassError::Unauthorized)
        );
        // Its pause stays until it expires or the admin lifts it.
        assert!(f.state.is_paused(WITHDRAW, NOW));
    }

    #[test]
    fn capacity_is_bounded_and_expired_entries_are_pruned() {
        let mut f = fx();
        let all_but_repay = !scope_bit(REPAY);
        apply_pause(
            &mut f.state,
            &mut f.ladmin,
            &f.config,
            f.admin,
            all_but_repay,
            10,
            0,
            NOW,
        )
        .unwrap();
        assert_eq!(f.state.active.len(), 63);
        apply_pause(&mut f.state, &mut f.l1, &f.config, f.g1, W, 10, 0, NOW).unwrap();
        assert_eq!(f.state.active.len(), 64);
        assert_eq!(
            code(apply_pause(
                &mut f.state,
                &mut f.l2,
                &f.config,
                f.g2,
                W,
                10,
                0,
                NOW
            )),
            is(BreakglassError::TooManyActivePauses)
        );
        // Once they expire, the next write prunes them. (On-chain, the failed
        // call above reverted whole; here g2's ledger was charged, so use the admin.)
        apply_pause(
            &mut f.state,
            &mut f.ladmin,
            &f.config,
            f.admin,
            W,
            10,
            0,
            NOW + 10,
        )
        .unwrap();
        assert_eq!(f.state.active.len(), 1);
    }

    #[test]
    fn scopes_in_mask() {
        assert_eq!(scopes_in(0b1011).collect::<Vec<_>>(), vec![0, 1, 3]);
        assert_eq!(scopes_in(u64::MAX).count(), 64);
        assert_eq!(scopes_in(1 << 63).collect::<Vec<_>>(), vec![63]);
    }
}
