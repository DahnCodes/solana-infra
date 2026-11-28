use anchor_lang::prelude::*;

use crate::{
    config_logic::{is_tightening, validate_limiter_params},
    constants::*,
    errors::BreakglassError,
    events::LimitsTightened,
    state::*,
};

/// Admin tightens a limiter at once (lower caps or thresholds, longer holds,
/// ...). Fails with NotTightening if any field loosens: use propose_config.
#[event_cpi]
#[derive(Accounts)]
pub struct TightenLimits<'info> {
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        has_one = admin @ BreakglassError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [FLOW_SEED, config.key().as_ref(), flow_limiter.mint.as_ref()],
        bump = flow_limiter.bump,
        has_one = config
    )]
    pub flow_limiter: Account<'info, FlowLimiter>,
}

pub fn handler(ctx: Context<TightenLimits>, params: LimiterParams) -> Result<()> {
    validate_limiter_params(&params)?;
    let limiter = &mut ctx.accounts.flow_limiter;
    require!(
        is_tightening(&limiter.params(), &params),
        BreakglassError::NotTightening
    );
    let now = Clock::get()?.unix_timestamp;
    limiter.apply_params(&params, now);
    let (config, flow_limiter, mint) = (ctx.accounts.config.key(), limiter.key(), limiter.mint);
    emit_cpi!(LimitsTightened {
        config,
        flow_limiter,
        mint,
    });
    Ok(())
}
