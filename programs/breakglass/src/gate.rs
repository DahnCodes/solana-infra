//! Shared checks for instructions a protected program calls by CPI.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, state::*};

/// The signer must be the protected program's `["breakglass-gate"]` PDA, so
/// only that program (not a user, not another program) can drive its gate.
pub fn require_gate_signer(config: &ProtocolConfig, gate_signer: &Pubkey) -> Result<()> {
    let (expected, _) =
        Pubkey::find_program_address(&[GATE_SIGNER_SEED], &config.protected_program);
    require_keys_eq!(*gate_signer, expected, BreakglassError::InvalidCaller);
    Ok(())
}

/// Auto-trip `scope` until `now + limiter.auto_trip_secs`. Admin-only to lift.
pub fn auto_trip(
    pause_state: &mut PauseState,
    limiter_key: Pubkey,
    limiter: &FlowLimiter,
    now: i64,
) -> Result<i64> {
    let until = now
        .checked_add(limiter.auto_trip_secs)
        .ok_or(BreakglassError::MathOverflow)?;
    pause_state.prune_expired(now);
    pause_state.upsert(
        limiter.scope,
        PauseKind::AutoTrip,
        limiter_key,
        until,
        AUTO_TRIP_REASON,
        0,
    )
}
