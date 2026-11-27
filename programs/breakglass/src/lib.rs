//! Breakglass on-chain program.
//!
//! A gate and a ledger, never a custodian: this program stores pause state and
//! outflow counters and tells the protected program Allow / Hold / Deny. It must
//! never hold token authority or transfer user funds. See docs/SPEC.md.

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("8Y9J7ZBRHZ9b8Cr5ntMzwmA6KtwfPXdF1hLxuDE59xZ8");

#[program]
pub mod breakglass {
    use super::*;

    /// Register a protected program with Breakglass. Phase 0.
    pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitConfigArgs) -> Result<()> {
        instructions::initialize_config::handler(ctx, args)
    }

    /// Read-only gate for non-outflow instructions: fails if `scope` is paused. Phase 0/1.
    pub fn check_scope(ctx: Context<CheckScope>, scope: u8) -> Result<()> {
        instructions::check_scope::handler(ctx, scope)
    }

    // Phase 1: pause, renew_pause, unpause, remove_guardian
    // Phase 2: init_flow_limiter, check_outflow, claim_held, freeze_held, reject_held
    // Phase 4: propose_config, execute_config, veto_config, cancel_config, release_held
    // See docs/BUILD_PLAN.md.
}
