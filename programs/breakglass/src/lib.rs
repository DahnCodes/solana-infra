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
pub mod pause_logic;
pub mod state;

use instructions::*;

declare_id!("AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB");

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

    /// Pause `scopes` (bitmask) for `duration` seconds. Guardian: bounded by the
    /// max duration, cooldown and budget. Admin: unbounded. Phase 1.
    pub fn pause(ctx: Context<Pause>, scopes: u64, duration: i64, reason: u16) -> Result<()> {
        instructions::pause::pause_handler(ctx, scopes, duration, reason)
    }

    /// Extend running pauses by the guardian max duration. Guardian: own pauses,
    /// up to the renew cap. Admin: any pause, no cap. Phase 1.
    pub fn renew_pause(ctx: Context<Pause>, scopes: u64) -> Result<()> {
        instructions::pause::renew_handler(ctx, scopes)
    }

    /// Lift pauses early. Admin: any. Guardian: only its own. Phase 1.
    pub fn unpause(ctx: Context<Unpause>, scopes: u64) -> Result<()> {
        instructions::unpause::handler(ctx, scopes)
    }

    /// Admin removes a guardian, effective immediately. Phase 1.
    pub fn remove_guardian(ctx: Context<RemoveGuardian>, guardian: Pubkey) -> Result<()> {
        instructions::remove_guardian::handler(ctx, guardian)
    }

    // Phase 2: init_flow_limiter, check_outflow, claim_held, freeze_held, reject_held
    // Phase 4: propose_config, execute_config, veto_config, cancel_config, release_held
    // See docs/BUILD_PLAN.md.
}
