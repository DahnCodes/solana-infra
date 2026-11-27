use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, events::GuardianRemoved, state::*};

/// Admin only, applies immediately (removing a guardian tightens nothing the
/// guardian could abuse). The removed guardian's running pauses stay until
/// they expire or the admin lifts them.
#[event_cpi]
#[derive(Accounts)]
pub struct RemoveGuardian<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        has_one = admin @ BreakglassError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,
}

pub fn handler(ctx: Context<RemoveGuardian>, guardian: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    let idx = config
        .guardians
        .iter()
        .position(|g| *g == guardian)
        .ok_or(BreakglassError::GuardianNotFound)?;
    config.guardians.remove(idx);
    let config_key = config.key();
    emit_cpi!(GuardianRemoved {
        config: config_key,
        guardian,
    });
    Ok(())
}
