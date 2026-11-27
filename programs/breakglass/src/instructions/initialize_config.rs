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

    /// CHECK: the protocol admin, a plain pubkey (typically a Squads vault PDA).
    /// It doesn't sign here: the upgrade authority below authorizes the
    /// registration, so a multisig vault can be named admin directly.
    #[account(constraint = admin.key() != Pubkey::default() @ BreakglassError::Unauthorized)]
    pub admin: UncheckedAccount<'info>,

    /// The protected program's upgrade authority. Only it can register the
    /// program, so nobody can squat a protocol's config PDA and become its admin.
    pub upgrade_authority: Signer<'info>,

    /// CHECK: only used as a seed and checked to be an executable program.
    #[account(constraint = protected_program.executable @ BreakglassError::NotExecutable)]
    pub protected_program: UncheckedAccount<'info>,

    /// The protected program's ProgramData (BPF upgradeable loader). Immutable
    /// or non-upgradeable programs can't be registered (fail closed).
    #[account(
        seeds = [protected_program.key().as_ref()],
        bump,
        seeds::program = anchor_lang::solana_program::bpf_loader_upgradeable::ID,
        constraint = protected_program_data.upgrade_authority_address
            == Some(upgrade_authority.key()) @ BreakglassError::Unauthorized
    )]
    pub protected_program_data: Account<'info, ProgramData>,

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
