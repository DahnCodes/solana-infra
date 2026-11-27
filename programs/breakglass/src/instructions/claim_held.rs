use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    errors::BreakglassError,
    events::*,
    gate::{auto_trip, require_gate_signer},
    limiter::{evaluate, Verdict},
    state::*,
};

/// Called by the protected program (CPI) when the owner claims a held
/// withdrawal. Allow: the hold is marked Claimed and the protocol transfers.
/// Hold: the claim would cross the window cap, so the scope is auto-tripped
/// and the hold stays Queued (claim again later).
#[event_cpi]
#[derive(Accounts)]
pub struct ClaimHeld<'info> {
    pub gate_signer: Signer<'info>,

    pub owner: Signer<'info>,

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
        mut,
        seeds = [FLOW_SEED, config.key().as_ref(), flow_limiter.mint.as_ref()],
        bump = flow_limiter.bump,
        has_one = config,
        has_one = vault @ BreakglassError::WrongVault
    )]
    pub flow_limiter: Account<'info, FlowLimiter>,

    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [HOLD_SEED, config.key().as_ref(), owner.key().as_ref(), &hold.nonce.to_le_bytes()],
        bump = hold.bump,
        has_one = config,
        has_one = owner,
        constraint = hold.mint == flow_limiter.mint @ BreakglassError::WrongHold,
        constraint = hold.scope == flow_limiter.scope @ BreakglassError::WrongHold
    )]
    pub hold: Account<'info, PendingWithdrawal>,
}

pub fn handler(ctx: Context<ClaimHeld>) -> Result<Decision> {
    let now = Clock::get()?.unix_timestamp;
    require_gate_signer(&ctx.accounts.config, &ctx.accounts.gate_signer.key())?;
    let hold = &ctx.accounts.hold;
    match hold.status {
        HoldStatus::Queued => require!(now >= hold.release_at, BreakglassError::HoldNotReleased),
        HoldStatus::Released => {}
        HoldStatus::Frozen => return err!(BreakglassError::HoldFrozen),
        HoldStatus::Rejected | HoldStatus::Claimed => {
            return err!(BreakglassError::HoldInvalidState)
        }
    }
    require!(
        !ctx.accounts.pause_state.is_paused(hold.scope, now),
        BreakglassError::ScopePaused
    );

    let config_key = ctx.accounts.config.key();
    let limiter_key = ctx.accounts.flow_limiter.key();
    let hold_key = hold.key();
    let (amount, owner, mint, scope, released) = (
        hold.amount,
        hold.owner,
        hold.mint,
        hold.scope,
        hold.status == HoldStatus::Released,
    );
    let balance = ctx.accounts.vault.amount;
    let limiter = &mut ctx.accounts.flow_limiter;

    let (window_total, window_cap) = if released {
        // Released through the timelock (Phase 4): the admin's decision, not
        // capped again. Still recorded so the window reflects the outflow.
        limiter.roll(now);
        limiter.record(amount);
        (limiter.window_total(), limiter.effective_cap(balance))
    } else {
        match evaluate(limiter, amount, balance, now, true) {
            Verdict::Allow {
                window_total,
                window_cap,
            } => (window_total, window_cap),
            Verdict::HoldBreach {
                window_total,
                window_cap,
            } => {
                let paused_until = auto_trip(
                    &mut ctx.accounts.pause_state,
                    limiter_key,
                    &ctx.accounts.flow_limiter,
                    now,
                )?;
                emit_cpi!(LimitTripped {
                    config: config_key,
                    mint,
                    scope,
                    window_total,
                    window_cap,
                    paused_until,
                });
                emit_cpi!(Paused {
                    config: config_key,
                    scopes_mask: scope_bit(scope),
                    paused_until,
                    by: limiter_key,
                    kind: PauseKind::AutoTrip.code(),
                    reason: AUTO_TRIP_REASON,
                });
                return Ok(Decision::Hold);
            }
            // Claims skip the threshold and screening.
            Verdict::HoldLarge | Verdict::HoldScreen => unreachable!(),
        }
    };

    ctx.accounts.hold.status = HoldStatus::Claimed;
    emit_cpi!(HoldResolved {
        config: config_key,
        hold: hold_key,
        outcome: 0,
    });
    emit_cpi!(OutflowRecorded {
        config: config_key,
        mint,
        owner,
        amount,
        window_total,
        window_cap,
    });
    Ok(Decision::Allow)
}
