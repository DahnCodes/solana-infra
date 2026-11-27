use anchor_lang::prelude::*;

use crate::{constants::*, errors::BreakglassError, events::ConfigInitialized, state::*};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitConfigArgs {
    pub guardians: Vec<Pubkey>,
    pub unpausable_mask: u64,
    /// None = DEFAULT_TIMELOCK_SECS. Must be within [MIN_TIMELOCK_SECS, MAX_TIMELOCK_SECS].
    pub timelock_secs: Option<i64>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The protocol admin (can be a Squads vault PDA signing via the multisig).
    pub admin: Signer<'info>,

    /// CHECK: only used as a seed and checked to be an executable program.
    #[account(constraint = protected_program.executable @ BreakglassError::NotExecutable)]
    pub protected_program: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [CONFIG_SEED, protected_program.key().as_ref()],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = payer,
        space = 8 + PauseState::INIT_SPACE,
        seeds = [PAUSE_SEED, config.key().as_ref()],
        bump
    )]
    pub pause_state: Account<'info, PauseState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>, args: InitConfigArgs) -> Result<()> {
    require!(
        args.guardians.len() <= MAX_GUARDIANS,
        BreakglassError::TooManyGuardians
    );
    let timelock = args.timelock_secs.unwrap_or(DEFAULT_TIMELOCK_SECS);
    require!(
        (MIN_TIMELOCK_SECS..=MAX_TIMELOCK_SECS).contains(&timelock),
        BreakglassError::InvalidTimelock
    );

    let config = &mut ctx.accounts.config;
    config.version = 1;
    config.bump = ctx.bumps.config;
    config.protected_program = ctx.accounts.protected_program.key();
    config.admin = ctx.accounts.admin.key();
    config.guardians = args.guardians.clone();
    config.unpausable_mask = args.unpausable_mask;
    config.policy = PausePolicy::default();
    config.timelock_secs = timelock;
    config.next_change_id = 0;

    let pause_state = &mut ctx.accounts.pause_state;
    pause_state.bump = ctx.bumps.pause_state;
    pause_state.config = config.key();
    pause_state.active = Vec::new();

    emit_cpi!(ConfigInitialized {
        config: config.key(),
        protected_program: config.protected_program,
        admin: config.admin,
        guardians: args.guardians,
    });
    Ok(())
}
