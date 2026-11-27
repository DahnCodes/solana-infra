use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, state::*};

/// Read-only gate. Seeds and owner are checked by Anchor, so a protocol cannot be
/// tricked into reading a fake PauseState (fail closed).
#[derive(Accounts)]
pub struct CheckScope<'info> {
    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        seeds = [PAUSE_SEED, config.key().as_ref()],
        bump = pause_state.bump,
        has_one = config
    )]
    pub pause_state: Account<'info, PauseState>,
}

pub fn handler(ctx: Context<CheckScope>, scope: u8) -> Result<()> {
    require!(scope < MAX_SCOPES, BreakglassError::InvalidScope);
    let now = Clock::get()?.unix_timestamp;
    require!(
        !ctx.accounts.pause_state.is_paused(scope, now),
        BreakglassError::ScopePaused
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PauseKind, ScopePause};

    fn state_with(scope: u8, until: i64) -> PauseState {
        PauseState {
            bump: 0,
            config: Pubkey::default(),
            active: vec![ScopePause {
                scope,
                paused_until: until,
                paused_by: Pubkey::default(),
                kind: PauseKind::Guardian,
                renewals: 0,
                reason: 0,
            }],
        }
    }

    #[test]
    fn pause_is_active_until_expiry() {
        let s = state_with(scopes::WITHDRAW, 1_000);
        assert!(s.is_paused(scopes::WITHDRAW, 999));
        assert!(!s.is_paused(scopes::WITHDRAW, 1_000));
        assert!(!s.is_paused(scopes::DEPOSIT, 999));
    }
}
