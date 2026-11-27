//! breakglass-sdk: what a protocol calls to use the Breakglass gate.
//!
//! - `require_scope_open`: CPI to `check_scope` (non-outflow instructions).
//! - `check_outflow`: the outflow gate, returns `Decision::{Allow, Hold}`.
//! - `claim_held` / `reject_held`: resolve a held withdrawal.
//! - `invariants::{Snapshot, assert_invariants}`: zero-loss in-transaction
//!   invariants (snapshot before the body, assert after).
//!   A `#[breakglass::protected]` macro comes later.
//!
//! Integration rules (fail closed):
//! - Type the config as `Account<'info, breakglass::state::ProtocolConfig>` and
//!   constrain `config.protected_program == crate::ID`. Otherwise a caller
//!   could pass the (unpaused) config of a different protocol.
//! - Derive the gate signer as `["breakglass-gate"]` under your own program ID
//!   (`#[account(seeds = [GATE_SIGNER_SEED], bump)]`) and pass its bump here.
//! - Allow: transfer. Hold: record that the amount is pending and do NOT
//!   transfer. Every helper returns an error for anything else.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::get_return_data;

pub mod invariants;
pub use invariants::{assert_invariants, Snapshot};

pub use breakglass;
pub use breakglass::constants::{scopes, GATE_SIGNER_SEED};
pub use breakglass::errors::BreakglassError;
pub use breakglass::state::Decision;

/// Accounts every gate CPI needs. `gate_signer` is the protocol's
/// `["breakglass-gate"]` PDA; `event_authority` is Breakglass's
/// `["__event_authority"]` PDA (for `emit_cpi!`).
#[derive(Clone)]
pub struct Gate<'info> {
    pub breakglass_program: AccountInfo<'info>,
    pub event_authority: AccountInfo<'info>,
    pub gate_signer: AccountInfo<'info>,
    pub gate_signer_bump: u8,
    pub config: AccountInfo<'info>,
}

/// Accounts for `check_outflow` and `claim_held` besides the `Gate`.
#[derive(Clone)]
pub struct Outflow<'info> {
    pub pause_state: AccountInfo<'info>,
    pub flow_limiter: AccountInfo<'info>,
    /// The vault token account registered in the limiter.
    pub vault: AccountInfo<'info>,
    /// The PendingWithdrawal PDA `["hold", config, owner, nonce]`.
    pub hold: AccountInfo<'info>,
}

/// Fails with `ScopePaused` if `scope` is currently paused for this protocol.
pub fn require_scope_open<'info>(
    breakglass_program: AccountInfo<'info>,
    config: AccountInfo<'info>,
    pause_state: AccountInfo<'info>,
    scope: u8,
) -> Result<()> {
    let ctx = CpiContext::new(
        breakglass_program,
        breakglass::cpi::accounts::CheckScope {
            config,
            pause_state,
        },
    );
    breakglass::cpi::check_scope(ctx, scope)
}

/// The outflow gate. Call before transferring `amount` out of the vault.
/// Returns Allow (transfer now) or Hold (a PendingWithdrawal was created and
/// paid for by `payer`; don't transfer). A paused scope fails with `ScopePaused`.
#[allow(clippy::too_many_arguments)]
pub fn check_outflow<'info>(
    gate: &Gate<'info>,
    accts: &Outflow<'info>,
    payer: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    scope: u8,
    amount: u64,
    owner: Pubkey,
    hold_nonce: u64,
) -> Result<Decision> {
    let bump = [gate.gate_signer_bump];
    let seeds: &[&[u8]] = &[GATE_SIGNER_SEED, &bump];
    let signer = &[seeds];
    let ctx = CpiContext::new_with_signer(
        gate.breakglass_program.clone(),
        breakglass::cpi::accounts::CheckOutflow {
            gate_signer: gate.gate_signer.clone(),
            payer,
            config: gate.config.clone(),
            pause_state: accts.pause_state.clone(),
            flow_limiter: accts.flow_limiter.clone(),
            vault: accts.vault.clone(),
            hold: accts.hold.clone(),
            system_program,
            event_authority: gate.event_authority.clone(),
            program: gate.breakglass_program.clone(),
        },
        signer,
    );
    breakglass::cpi::check_outflow(ctx, scope, amount, owner, hold_nonce)?;
    read_decision()
}

/// Claim a held withdrawal for `owner` (who must sign). Allow: transfer
/// `hold.amount` now. Hold: the claim would cross the window cap and the scope
/// was auto-tripped; don't transfer, the hold stays claimable later.
pub fn claim_held<'info>(
    gate: &Gate<'info>,
    accts: &Outflow<'info>,
    owner: AccountInfo<'info>,
) -> Result<Decision> {
    let bump = [gate.gate_signer_bump];
    let seeds: &[&[u8]] = &[GATE_SIGNER_SEED, &bump];
    let signer = &[seeds];
    let ctx = CpiContext::new_with_signer(
        gate.breakglass_program.clone(),
        breakglass::cpi::accounts::ClaimHeld {
            gate_signer: gate.gate_signer.clone(),
            owner,
            config: gate.config.clone(),
            pause_state: accts.pause_state.clone(),
            flow_limiter: accts.flow_limiter.clone(),
            vault: accts.vault.clone(),
            hold: accts.hold.clone(),
            event_authority: gate.event_authority.clone(),
            program: gate.breakglass_program.clone(),
        },
        signer,
    );
    breakglass::cpi::claim_held(ctx)?;
    read_decision()
}

/// The admin (who must sign) rejects a hold. On success the protocol must
/// return `hold.amount` to the user's position.
pub fn reject_held<'info>(
    gate: &Gate<'info>,
    admin: AccountInfo<'info>,
    hold: AccountInfo<'info>,
) -> Result<()> {
    let bump = [gate.gate_signer_bump];
    let seeds: &[&[u8]] = &[GATE_SIGNER_SEED, &bump];
    let signer = &[seeds];
    let ctx = CpiContext::new_with_signer(
        gate.breakglass_program.clone(),
        breakglass::cpi::accounts::RejectHeld {
            admin,
            gate_signer: gate.gate_signer.clone(),
            config: gate.config.clone(),
            hold,
            event_authority: gate.event_authority.clone(),
            program: gate.breakglass_program.clone(),
        },
        signer,
    );
    breakglass::cpi::reject_held(ctx)
}

/// Read the decision Breakglass just returned. Fails closed: missing return
/// data, data from another program, or a Deny all become errors.
fn read_decision() -> Result<Decision> {
    let (program, data) = get_return_data().ok_or(BreakglassError::InvalidCaller)?;
    require_keys_eq!(program, breakglass::ID, BreakglassError::InvalidCaller);
    let decision =
        Decision::try_from_slice(&data).map_err(|_| error!(BreakglassError::InvalidCaller))?;
    match decision {
        Decision::Deny => err!(BreakglassError::ScopePaused),
        d => Ok(d),
    }
}
