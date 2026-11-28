use anchor_lang::prelude::*;

use crate::{
    constants::*, errors::BreakglassError, events::HoldFrozen, pause_logic::role_of, state::*,
};

/// A guardian (or the admin) freezes a queued hold. A frozen hold can never be
/// claimed; only `reject_held` (admin) or a timelocked release (Phase 4) ends it.
#[event_cpi]
#[derive(Accounts)]
pub struct FreezeHeld<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [HOLD_SEED, config.key().as_ref(), hold.owner.as_ref(), &hold.nonce.to_le_bytes()],
        bump = hold.bump,
        has_one = config
    )]
    pub hold: Account<'info, PendingWithdrawal>,
}

pub fn handler(ctx: Context<FreezeHeld>) -> Result<()> {
    let by = ctx.accounts.authority.key();
    role_of(&ctx.accounts.config, &by)?;
    let hold = &mut ctx.accounts.hold;
    require!(
        hold.status == HoldStatus::Queued,
        BreakglassError::HoldInvalidState
    );
    hold.status = HoldStatus::Frozen;
    let (config, hold) = (ctx.accounts.config.key(), ctx.accounts.hold.key());
    emit_cpi!(HoldFrozen { config, hold, by });
    Ok(())
}
