//! Breakglass on-chain program.
//!
//! A gate and a ledger, never a custodian: this program stores pause state and
//! outflow counters and tells the protected program Allow / Hold / Deny. It must
//! never hold token authority or transfer user funds. See docs/SPEC.md.

use anchor_lang::prelude::*;

pub mod config_logic;
pub mod constants;
pub mod errors;
pub mod events;
pub mod gate;
pub mod instructions;
pub mod limiter;
pub mod pause_logic;
pub mod state;

use instructions::*;
use state::{ConfigAction, Decision, LimiterParams};

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

    /// Admin creates the outflow limiter for one mint. Phase 2.
    pub fn init_flow_limiter(
        ctx: Context<InitFlowLimiter>,
        args: InitFlowLimiterArgs,
    ) -> Result<()> {
        instructions::init_flow_limiter::handler(ctx, args)
    }

    /// The outflow gate. CPI from the protected program's gate PDA. Returns
    /// Allow or Hold; a paused scope fails with ScopePaused. Phase 2.
    pub fn check_outflow(
        ctx: Context<CheckOutflow>,
        scope: u8,
        amount: u64,
        owner: Pubkey,
        hold_nonce: u64,
    ) -> Result<Decision> {
        instructions::check_outflow::handler(ctx, scope, amount, owner, hold_nonce)
    }

    /// Claim a held withdrawal after `release_at`. CPI from the protected
    /// program, signed by the owner. Returns Allow or Hold. Phase 2.
    pub fn claim_held(ctx: Context<ClaimHeld>) -> Result<Decision> {
        instructions::claim_held::handler(ctx)
    }

    /// Guardian (or admin) freezes a queued hold. Phase 2.
    pub fn freeze_held(ctx: Context<FreezeHeld>) -> Result<()> {
        instructions::freeze_held::handler(ctx)
    }

    /// Admin rejects a hold, through the protected program. Phase 2.
    pub fn reject_held(ctx: Context<RejectHeld>) -> Result<()> {
        instructions::reject_held::handler(ctx)
    }

    /// Admin queues a timelocked change (raise limits, add a guardian, set
    /// admin, release a hold, change policy). Phase 4.
    pub fn propose_config(ctx: Context<ProposeConfig>, action: ConfigAction) -> Result<()> {
        instructions::propose_config::handler(ctx, action)
    }

    /// Anyone runs a pending change after its timelock, unless vetoed or cancelled. Phase 4.
    pub fn execute_config(ctx: Context<ExecuteConfig>) -> Result<()> {
        instructions::execute_config::handler(ctx)
    }

    /// A guardian vetoes a pending change. Phase 4.
    pub fn veto_config(ctx: Context<VetoConfig>) -> Result<()> {
        instructions::veto_config::handler(ctx)
    }

    /// The admin cancels a pending change. Phase 4.
    pub fn cancel_config(ctx: Context<CancelConfig>) -> Result<()> {
        instructions::cancel_config::handler(ctx)
    }

    /// The admin tightens a limiter immediately (no timelock). Phase 4.
    pub fn tighten_limits(ctx: Context<TightenLimits>, params: LimiterParams) -> Result<()> {
        instructions::tighten_limits::handler(ctx, params)
    }
    // See docs/BUILD_PLAN.md.
}
