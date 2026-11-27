use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::token_interface::TokenAccount;

use crate::{
    constants::*,
    errors::BreakglassError,
    events::*,
    gate::{auto_trip, require_gate_signer},
    limiter::{evaluate, Verdict},
    state::*,
};

/// Called by the protected program (CPI, signed by its `["breakglass-gate"]`
/// PDA) before every outflow. Returns Allow or Hold as Anchor return data; a
/// paused scope fails with `ScopePaused` (that is the Deny).
///
/// `hold` is the PendingWithdrawal PDA `["hold", config, owner, hold_nonce]`.
/// It is only created on Hold (paid by `payer`), so the caller passes it on
/// every call and picks a nonce that isn't in use.
#[event_cpi]
#[derive(Accounts)]
pub struct CheckOutflow<'info> {
    pub gate_signer: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED, config.protected_program.as_ref()],
        bump = config.bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// Writable for the auto-trip on a cap breach.
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

    /// CHECK: created here on Hold; the address is checked against its seeds.
    #[account(mut)]
    pub hold: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CheckOutflow>,
    scope: u8,
    amount: u64,
    owner: Pubkey,
    hold_nonce: u64,
) -> Result<Decision> {
    let now = Clock::get()?.unix_timestamp;
    require_gate_signer(&ctx.accounts.config, &ctx.accounts.gate_signer.key())?;
    require!(
        scope == ctx.accounts.flow_limiter.scope,
        BreakglassError::InvalidScope
    );
    require!(
        !ctx.accounts.pause_state.is_paused(scope, now),
        BreakglassError::ScopePaused
    );

    let config_key = ctx.accounts.config.key();
    let limiter_key = ctx.accounts.flow_limiter.key();
    let mint = ctx.accounts.flow_limiter.mint;
    let balance = ctx.accounts.vault.amount;
    let verdict = evaluate(&mut ctx.accounts.flow_limiter, amount, balance, now, false);

    let (kind, secs) = match verdict {
        Verdict::Allow {
            window_total,
            window_cap,
        } => {
            emit_cpi!(OutflowRecorded {
                config: config_key,
                mint,
                owner,
                amount,
                window_total,
                window_cap,
            });
            return Ok(Decision::Allow);
        }
        Verdict::HoldLarge => (HoldKind::Large, ctx.accounts.flow_limiter.hold_secs),
        Verdict::HoldScreen => (HoldKind::Screen, ctx.accounts.flow_limiter.screen_secs),
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
            (HoldKind::Limit, ctx.accounts.flow_limiter.hold_secs)
        }
    };

    let release_at = now.checked_add(secs).ok_or(BreakglassError::MathOverflow)?;
    let hold = ctx.accounts.hold.key();
    create_hold(
        &ctx.accounts.payer,
        &ctx.accounts.hold,
        &ctx.accounts.system_program,
        PendingWithdrawal {
            bump: 0,
            config: config_key,
            owner,
            mint,
            amount,
            nonce: hold_nonce,
            created_at: now,
            release_at,
            status: HoldStatus::Queued,
            scope,
            kind,
        },
    )?;
    match kind {
        HoldKind::Large => emit_cpi!(LargeWithdrawalQueued {
            config: config_key,
            hold,
            mint,
            owner,
            amount,
            release_at,
        }),
        HoldKind::Limit => emit_cpi!(LimitHoldQueued {
            config: config_key,
            hold,
            mint,
            owner,
            amount,
            release_at,
        }),
        HoldKind::Screen => emit_cpi!(WithdrawalScreenQueued {
            config: config_key,
            hold,
            mint,
            owner,
            amount,
            release_at,
        }),
    }
    Ok(Decision::Hold)
}

/// Create the PendingWithdrawal PDA. The only `invoke_signed` in Breakglass:
/// the PDA signs for its own creation (system program). No tokens move.
fn create_hold<'info>(
    payer: &Signer<'info>,
    hold: &UncheckedAccount<'info>,
    system_program: &Program<'info, System>,
    mut record: PendingWithdrawal,
) -> Result<()> {
    let nonce = record.nonce.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(
        &[
            HOLD_SEED,
            record.config.as_ref(),
            record.owner.as_ref(),
            &nonce,
        ],
        &crate::ID,
    );
    require_keys_eq!(hold.key(), expected, BreakglassError::WrongHold);
    record.bump = bump;

    let space = 8 + PendingWithdrawal::INIT_SPACE;
    let seeds: &[&[u8]] = &[
        HOLD_SEED,
        record.config.as_ref(),
        record.owner.as_ref(),
        &nonce,
        &[bump],
    ];
    system_program::create_account(
        CpiContext::new_with_signer(
            system_program.to_account_info(),
            CreateAccount {
                from: payer.to_account_info(),
                to: hold.to_account_info(),
            },
            &[seeds],
        ),
        Rent::get()?.minimum_balance(space),
        space as u64,
        &crate::ID,
    )?;
    let mut data = hold.try_borrow_mut_data()?;
    record.try_serialize(&mut &mut data[..])?;
    Ok(())
}
