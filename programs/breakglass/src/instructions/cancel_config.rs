use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, events::ConfigChangeCancelled, state::*};

/// The admin withdraws a pending change (also allowed after a veto).
#[event_cpi]
#[derive(Accounts)]
pub struct CancelConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        has_one = admin @ BreakglassError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CFGCHG_SEED, config.key().as_ref(), &pending.id.to_le_bytes()],
        bump = pending.bump,
        has_one = config
    )]
    pub pending: Account<'info, PendingConfig>,
}

pub fn handler(ctx: Context<CancelConfig>) -> Result<()> {
    let pending = &mut ctx.accounts.pending;
    require!(
        !pending.executed && !pending.cancelled,
        BreakglassError::ChangeClosed
    );
    pending.cancelled = true;
    let (config, change) = (ctx.accounts.config.key(), ctx.accounts.pending.key());
    emit_cpi!(ConfigChangeCancelled { config, change });
    Ok(())
}
