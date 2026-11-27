use anchor_lang::prelude::*;

use crate::{
    config_logic::validate_action, constants::*, errors::BreakglassError,
    events::ConfigChangeProposed, state::*,
};

/// Admin queues a loosening change behind the timelock. `payer` funds the
/// PendingConfig account (for a Squads admin, both are the vault).
#[event_cpi]
#[derive(Accounts)]
pub struct ProposeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        has_one = admin @ BreakglassError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = payer,
        space = 8 + PendingConfig::INIT_SPACE,
        seeds = [CFGCHG_SEED, config.key().as_ref(), &config.next_change_id.to_le_bytes()],
        bump
    )]
    pub pending: Account<'info, PendingConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ProposeConfig>, action: ConfigAction) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    validate_action(config, &action)?;
    let executable_at = now
        .checked_add(config.timelock_secs)
        .ok_or(BreakglassError::MathOverflow)?;

    let pending = &mut ctx.accounts.pending;
    pending.bump = ctx.bumps.pending;
    pending.config = config.key();
    pending.id = config.next_change_id;
    pending.action = action;
    pending.proposed_by = ctx.accounts.admin.key();
    pending.proposed_at = now;
    pending.executable_at = executable_at;
    pending.vetoed = false;
    pending.executed = false;
    pending.cancelled = false;
    config.next_change_id = config
        .next_change_id
        .checked_add(1)
        .ok_or(BreakglassError::MathOverflow)?;

    let (config, change) = (config.key(), pending.key());
    emit_cpi!(ConfigChangeProposed {
        config,
        change,
        action_kind: action.kind(),
        executable_at,
    });
    Ok(())
}
