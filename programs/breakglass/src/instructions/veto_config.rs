use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, events::ConfigChangeVetoed, state::*};

/// A guardian vetoes a pending change. A vetoed change can never execute.
#[event_cpi]
#[derive(Accounts)]
pub struct VetoConfig<'info> {
    pub guardian: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        constraint = config.is_guardian(&guardian.key()) @ BreakglassError::Unauthorized
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

pub fn handler(ctx: Context<VetoConfig>) -> Result<()> {
    let pending = &mut ctx.accounts.pending;
    require!(
        !pending.executed && !pending.cancelled,
        BreakglassError::ChangeClosed
    );
    require!(!pending.vetoed, BreakglassError::Vetoed);
    pending.vetoed = true;
    let (config, change, by) = (
        ctx.accounts.config.key(),
        ctx.accounts.pending.key(),
        ctx.accounts.guardian.key(),
    );
    emit_cpi!(ConfigChangeVetoed { config, change, by });
    Ok(())
}
