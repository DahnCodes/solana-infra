//! Zero-loss mode (1): in-transaction invariants. See docs/SPEC.md "Zero-loss mode".
//!
//! The protocol takes a `Snapshot` of its own books before the instruction
//! body and another after it (reload token accounts first), then calls
//! `assert_invariants`. Any mismatch reverts the whole transaction with
//! `InvariantViolated`, before funds can leave, so a bug that skips a
//! balance check can't drain the vault even below the window cap.
//!
//! These are the invariants for a simple deposit/withdraw vault (no fees,
//! no interest, no shares). Protocols with richer accounting write their own
//! checks with the same snapshot/assert pattern, for example "the share price
//! never falls".

use anchor_lang::prelude::*;

use breakglass::errors::BreakglassError;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Snapshot {
    /// Tokens the protocol actually holds (the vault token account balance).
    pub assets: u64,
    /// Everything the protocol owes, to all users, including held withdrawals.
    pub liabilities: u64,
    /// Everything owed to the user this instruction acts for: their position
    /// plus their withdrawals that are held but not yet claimed or rejected.
    pub user_claim: u64,
}

/// Which invariant failed (logged, and returned for tests).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Violation {
    /// The vault balance moved by a different amount than the user's claim:
    /// tokens left without being debited, or a claim grew from nothing.
    /// A claim can't go below zero, so this also guarantees nobody is paid
    /// more than they were owed (their recorded position plus holds).
    BalanceNotMatchingClaim,
    /// The total liabilities moved by a different amount than this user's
    /// claim, so another user's balance changed.
    OtherClaimsChanged,
    /// The vault holds less than it owes.
    Insolvent,
}

/// Pure check, usable in unit tests. `Ok(())` when every invariant holds.
pub fn check(before: &Snapshot, after: &Snapshot) -> core::result::Result<(), Violation> {
    let paid = before.assets as i128 - after.assets as i128;
    let claim_drop = before.user_claim as i128 - after.user_claim as i128;
    let liabilities_drop = before.liabilities as i128 - after.liabilities as i128;
    // paid == claim_drop and user_claim >= 0 imply paid <= before.user_claim.
    if paid != claim_drop {
        return Err(Violation::BalanceNotMatchingClaim);
    }
    if liabilities_drop != claim_drop {
        return Err(Violation::OtherClaimsChanged);
    }
    if after.assets < after.liabilities {
        return Err(Violation::Insolvent);
    }
    Ok(())
}

/// Fails with `InvariantViolated` (and logs which one) if any invariant breaks.
pub fn assert_invariants(before: &Snapshot, after: &Snapshot) -> Result<()> {
    check(before, after).map_err(|v| {
        msg!(
            "invariant violated: {:?} (before {:?}, after {:?})",
            v,
            before,
            after
        );
        error!(BreakglassError::InvariantViolated)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(assets: u64, liabilities: u64, user_claim: u64) -> Snapshot {
        Snapshot {
            assets,
            liabilities,
            user_claim,
        }
    }

    #[test]
    fn honest_flows_pass() {
        // withdraw 100 of a 300 position, paid now
        assert_eq!(check(&s(1_000, 1_000, 300), &s(900, 900, 200)), Ok(()));
        // withdraw 100 held: nothing moves, claim unchanged (position -> held)
        assert_eq!(check(&s(1_000, 1_000, 300), &s(1_000, 1_000, 300)), Ok(()));
        // claim a held 100
        assert_eq!(check(&s(1_000, 1_000, 300), &s(900, 900, 200)), Ok(()));
        // deposit 50
        assert_eq!(check(&s(1_000, 1_000, 300), &s(1_050, 1_050, 350)), Ok(()));
        // a donation to the vault, nothing withdrawn
        assert_eq!(check(&s(1_000, 1_000, 300), &s(1_000, 1_000, 300)), Ok(()));
    }

    #[test]
    fn drain_beyond_position_fails() {
        // position 100, the bug pays 1000 and saturates the position to 0
        assert_eq!(
            check(&s(10_000, 10_000, 100), &s(9_000, 9_000, 0)),
            Err(Violation::BalanceNotMatchingClaim)
        );
    }

    #[test]
    fn hold_larger_than_position_fails() {
        // position 100, the bug queues a 5000 hold (claim grows from 100 to 5000)
        assert_eq!(
            check(&s(10_000, 10_000, 100), &s(10_000, 10_000, 5_000)),
            Err(Violation::BalanceNotMatchingClaim)
        );
    }

    #[test]
    fn paying_out_without_debiting_fails() {
        assert_eq!(
            check(&s(1_000, 1_000, 300), &s(900, 1_000, 300)),
            Err(Violation::BalanceNotMatchingClaim)
        );
    }

    #[test]
    fn withdrawing_the_whole_position_is_the_most_that_passes() {
        assert_eq!(check(&s(1_000, 1_000, 50), &s(950, 950, 0)), Ok(()));
        // One more token can't be matched by the claim, which is already 0.
        assert_eq!(
            check(&s(1_000, 1_000, 50), &s(949, 949, 0)),
            Err(Violation::BalanceNotMatchingClaim)
        );
    }

    #[test]
    fn moving_another_users_balance_fails() {
        // user paid 100 and debited 100, but total liabilities dropped 200
        assert_eq!(
            check(&s(1_000, 1_000, 300), &s(900, 800, 200)),
            Err(Violation::OtherClaimsChanged)
        );
    }

    #[test]
    fn insolvency_fails() {
        // books were already short and nothing moved: still caught
        assert_eq!(
            check(&s(900, 1_000, 300), &s(900, 1_000, 300)),
            Err(Violation::Insolvent)
        );
    }

    #[test]
    fn extreme_values_dont_overflow() {
        let big = s(u64::MAX, u64::MAX, u64::MAX);
        assert_eq!(check(&big, &s(0, 0, 0)), Ok(()));
        assert_eq!(check(&s(0, 0, 0), &big), Ok(()));
        assert_eq!(
            check(&big, &s(0, u64::MAX, 0)),
            Err(Violation::OtherClaimsChanged)
        );
        assert_eq!(
            check(&big, &s(1, 0, 0)),
            Err(Violation::BalanceNotMatchingClaim)
        );
    }
}
