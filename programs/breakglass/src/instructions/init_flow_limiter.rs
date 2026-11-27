use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::{constants::*, errors::BreakglassError, limiter::validate_params, state::*};

/// Limiter parameters. `None` takes the spec default where one exists.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitFlowLimiterArgs {
    /// The outflow scope this limiter gates (the scope `check_outflow` must be called with).
    pub scope: u8,
    /// None = DEFAULT_WINDOW_SECS. Must be >= 12.
    pub window_secs: Option<i64>,
    /// Required, > 0.
    pub cap_absolute: u64,
    /// 0 = no balance-based cap. Max 10_000.
    pub cap_bps_of_vault: u16,
    /// Required. Withdrawals >= this are held for `hold_secs`.
    pub large_threshold: u64,
    /// 0 = absolute threshold only. Max 10_000.
    pub large_threshold_bps: u16,
    /// None = DEFAULT_HOLD_SECS.
    pub hold_secs: Option<i64>,
    /// None = config.policy.auto_trip_secs.
    pub auto_trip_secs: Option<i64>,
    /// None = DEFAULT_INSTANT_ALLOWANCE (no screening). Used from Phase 3.
    pub instant_allowance: Option<u64>,
    /// None = DEFAULT_SCREEN_SECS. Used from Phase 3.
    pub screen_secs: Option<i64>,
}

/// Admin only. One limiter per (config, mint); re-initializing fails.
/// Changing an existing limiter is a Phase 4 (timelocked to loosen) action.
#[derive(Accounts)]
pub struct InitFlowLimiter<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        has_one = admin @ BreakglassError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// The protocol's vault token account for `mint`.
    #[account(token::mint = mint)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        space = 8 + FlowLimiter::INIT_SPACE,
        seeds = [FLOW_SEED, config.key().as_ref(), mint.key().as_ref()],
        bump
    )]
    pub flow_limiter: Account<'info, FlowLimiter>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitFlowLimiter>, args: InitFlowLimiterArgs) -> Result<()> {
    require!(args.scope < MAX_SCOPES, BreakglassError::InvalidScope);
    let config = &ctx.accounts.config;
    require!(
        config.unpausable_mask & scope_bit(args.scope) == 0,
        BreakglassError::ScopeUnpausable
    );
    let window_secs = args.window_secs.unwrap_or(DEFAULT_WINDOW_SECS);
    let hold_secs = args.hold_secs.unwrap_or(DEFAULT_HOLD_SECS);
    let auto_trip_secs = args.auto_trip_secs.unwrap_or(config.policy.auto_trip_secs);
    let screen_secs = args.screen_secs.unwrap_or(DEFAULT_SCREEN_SECS);
    validate_params(
        window_secs,
        args.cap_absolute,
        args.cap_bps_of_vault,
        args.large_threshold_bps,
        hold_secs,
        auto_trip_secs,
        screen_secs,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let l = &mut ctx.accounts.flow_limiter;
    l.bump = ctx.bumps.flow_limiter;
    l.config = config.key();
    l.mint = ctx.accounts.mint.key();
    l.vault = ctx.accounts.vault.key();
    l.scope = args.scope;
    l.window_secs = window_secs;
    l.cap_absolute = args.cap_absolute;
    l.cap_bps_of_vault = args.cap_bps_of_vault;
    l.buckets = [0; LIMITER_BUCKETS];
    l.bucket_start = now;
    l.large_threshold = args.large_threshold;
    l.large_threshold_bps = args.large_threshold_bps;
    l.hold_secs = hold_secs;
    l.auto_trip_secs = auto_trip_secs;
    l.instant_allowance = args.instant_allowance.unwrap_or(DEFAULT_INSTANT_ALLOWANCE);
    l.screen_secs = screen_secs;
    let bucket_start = l.bucket_start - l.bucket_start.rem_euclid(l.bucket_width());
    l.bucket_start = bucket_start;
    Ok(())
}
