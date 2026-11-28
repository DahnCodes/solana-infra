use anchor_lang::prelude::*;

use crate::{
    config_logic::{require_executable, validate_action},
    constants::*,
    errors::BreakglassError,
    events::{ConfigChangeExecuted, HoldResolved},
    state::*,
};

/// Anyone executes a pending change once its timelock has passed, unless a
/// guardian vetoed it or the admin cancelled it. Pass `flow_limiter` for
/// RaiseLimits and `hold` for ReleaseHeld; leave them out otherwise.
#[event_cpi]
#[derive(Accounts)]
pub struct ExecuteConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CFGCHG_SEED, config.key().as_ref(), &pending.id.to_le_bytes()],
        bump = pending.bump,
        has_one = config
    )]
    pub pending: Account<'info, PendingConfig>,

    #[account(mut)]
    pub flow_limiter: Option<Account<'info, FlowLimiter>>,

    #[account(mut)]
    pub hold: Option<Account<'info, PendingWithdrawal>>,
}

pub fn handler(ctx: Context<ExecuteConfig>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require_executable(&ctx.accounts.pending, now)?;
    let action = ctx.accounts.pending.action;
    let config_key = ctx.accounts.config.key();
    validate_action(&ctx.accounts.config, &action)?;

    match action {
        ConfigAction::RaiseLimits { mint, params } => {
            let limiter = ctx
                .accounts
                .flow_limiter
                .as_mut()
                .ok_or(BreakglassError::WrongChangeAccounts)?;
            let (expected, _) = Pubkey::find_program_address(
                &[FLOW_SEED, config_key.as_ref(), mint.as_ref()],
                &crate::ID,
            );
            require!(
                limiter.key() == expected && limiter.config == config_key && limiter.mint == mint,
                BreakglassError::WrongChangeAccounts
            );
            limiter.apply_params(&params, now);
        }
        ConfigAction::AddGuardian { guardian } => {
            ctx.accounts.config.guardians.push(guardian);
        }
        ConfigAction::SetAdmin { admin } => {
            ctx.accounts.config.admin = admin;
        }
        ConfigAction::ReleaseHeld { hold } => {
            let h = ctx
                .accounts
                .hold
                .as_mut()
                .ok_or(BreakglassError::WrongChangeAccounts)?;
            require!(
                h.key() == hold && h.config == config_key,
                BreakglassError::WrongChangeAccounts
            );
            require!(
                matches!(h.status, HoldStatus::Queued | HoldStatus::Frozen),
                BreakglassError::HoldInvalidState
            );
            h.status = HoldStatus::Released;
            emit_cpi!(HoldResolved {
                config: config_key,
                hold,
                outcome: 1,
            });
        }
        ConfigAction::ChangePolicy {
            policy,
            unpausable_mask,
            timelock_secs,
        } => {
            let config = &mut ctx.accounts.config;
            config.policy = policy;
            config.unpausable_mask = unpausable_mask;
            config.timelock_secs = timelock_secs;
        }
    }

    ctx.accounts.pending.executed = true;
    let change = ctx.accounts.pending.key();
    emit_cpi!(ConfigChangeExecuted {
        config: config_key,
        change,
    });
    Ok(())
}
