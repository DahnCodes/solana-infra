use anchor_lang::prelude::*;

use crate::{constants::*, events::Unpaused, pause_logic::apply_unpause, state::*};

/// The admin lifts any pause. A guardian lifts only scopes whose running
/// pauses are all its own (never an auto-trip or admin pause).
#[event_cpi]
#[derive(Accounts)]
pub struct Unpause<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [PAUSE_SEED, config.key().as_ref()],
        bump = pause_state.bump,
        has_one = config
    )]
    pub pause_state: Account<'info, PauseState>,
}

pub fn handler(mut ctx: Context<Unpause>, scopes: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let by = ctx.accounts.authority.key();
    let config_key = ctx.accounts.config.key();
    let a = &mut ctx.accounts;
    let lifted = apply_unpause(&mut a.pause_state, &a.config, by, scopes, now)?;
    emit_cpi!(Unpaused {
        config: config_key,
        scopes_mask: lifted,
        by,
    });
    Ok(())
}
