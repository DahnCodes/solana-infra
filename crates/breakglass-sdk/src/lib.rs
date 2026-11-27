//! breakglass-sdk: what a protocol calls to use the Breakglass gate.
//!
//! Phase 0: `require_scope_open` (CPI to `check_scope`).
//! Phase 2: `check_outflow` returning `Decision`.
//! Phase 3: invariant snapshot/assert hooks.
//! Later:   `#[breakglass::protected]` attribute macro in a `breakglass-macros` crate.
//!
//! Integration rule (fail closed): the protocol's accounts struct must type the
//! config as `Account<'info, breakglass::state::ProtocolConfig>` and constrain
//! `config.protected_program == crate::ID`. Otherwise a caller could pass the
//! (unpaused) config of a different protocol.

use anchor_lang::prelude::*;

pub use breakglass;
pub use breakglass::constants::scopes;

/// Outcome of the outflow gate (Phase 2).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Hold,
    Deny,
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
