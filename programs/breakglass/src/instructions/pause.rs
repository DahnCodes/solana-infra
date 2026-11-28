use anchor_lang::prelude::*;

use crate::{
    constants::*,
    events::{PauseRenewed, Paused},
    pause_logic::{apply_pause, apply_renew},
    state::*,
};

/// Accounts for `pause` and `renew_pause`. The signer must be the admin or a
/// guardian; that is checked in the handler (Unauthorized otherwise).
/// `guardian_ledger` is the signer's ledger, created on first use and paid by
/// the signer. For the admin it is created but never charged.
#[event_cpi]
#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut)]
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

    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + GuardianLedger::INIT_SPACE,
        seeds = [GLEDGER_SEED, config.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub guardian_ledger: Account<'info, GuardianLedger>,

    pub system_program: Program<'info, System>,
}

pub fn pause_handler(
    mut ctx: Context<Pause>,
    scopes: u64,
    duration: i64,
    reason: u16,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let by = ctx.accounts.authority.key();
    let config_key = ctx.accounts.config.key();
    let a = &mut ctx.accounts;
    a.guardian_ledger
        .init_if_new(ctx.bumps.guardian_ledger, config_key, by, now);
    let out = apply_pause(
        &mut a.pause_state,
        &mut a.guardian_ledger,
        &a.config,
        by,
        scopes,
        duration,
        reason,
        now,
    )?;
    emit_cpi!(Paused {
        config: config_key,
        scopes_mask: scopes,
        paused_until: out.paused_until,
        by,
        kind: out.kind.code(),
        reason,
    });
    Ok(())
}

pub fn renew_handler(mut ctx: Context<Pause>, scopes: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let by = ctx.accounts.authority.key();
    let config_key = ctx.accounts.config.key();
    let a = &mut ctx.accounts;
    a.guardian_ledger
        .init_if_new(ctx.bumps.guardian_ledger, config_key, by, now);
    let out = apply_renew(
        &mut a.pause_state,
        &mut a.guardian_ledger,
        &a.config,
        by,
        scopes,
        now,
    )?;
    emit_cpi!(PauseRenewed {
        config: config_key,
        scopes_mask: scopes,
        paused_until: out.paused_until,
        by,
        renewals: out.renewals,
    });
    Ok(())
}
