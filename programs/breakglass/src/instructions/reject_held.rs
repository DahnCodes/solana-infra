use anchor_lang::prelude::*;

use crate::{
    constants::*, errors::BreakglassError, events::HoldResolved, gate::require_gate_signer,
    state::*,
};

/// The admin rejects a hold immediately (queued, frozen or released). Called
/// through the protected program (CPI with its gate signer), so the protocol
/// returns the amount to the user's position in the same transaction.
#[event_cpi]
#[derive(Accounts)]
pub struct RejectHeld<'info> {
    pub admin: Signer<'info>,

    pub gate_signer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump,
        has_one = admin @ BreakglassError::Unauthorized
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [HOLD_SEED, config.key().as_ref(), hold.owner.as_ref(), &hold.nonce.to_le_bytes()],
        bump = hold.bump,
        has_one = config
    )]
    pub hold: Account<'info, PendingWithdrawal>,
}

pub fn handler(ctx: Context<RejectHeld>) -> Result<()> {
    require_gate_signer(&ctx.accounts.config, &ctx.accounts.gate_signer.key())?;
    let hold = &mut ctx.accounts.hold;
    require!(
        matches!(
            hold.status,
            HoldStatus::Queued | HoldStatus::Frozen | HoldStatus::Released
        ),
        BreakglassError::HoldInvalidState
    );
    hold.status = HoldStatus::Rejected;
    let (config, hold) = (ctx.accounts.config.key(), ctx.accounts.hold.key());
    emit_cpi!(HoldResolved {
        config,
        hold,
        outcome: 2,
    });
    Ok(())
}
