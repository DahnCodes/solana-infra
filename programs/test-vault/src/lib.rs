//! test-vault: a minimal token vault that integrates Breakglass.
//! It exists to exercise the gate and to be attacked in tests. Never deploy to mainnet.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use breakglass_sdk::breakglass::{
    program::Breakglass,
    state::{PendingWithdrawal, ProtocolConfig},
};
use breakglass_sdk::{
    require_scope_open, scopes, BreakglassError, Decision, Gate, Outflow, GATE_SIGNER_SEED,
};

declare_id!("2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn");

pub const VAULT_SEED: &[u8] = b"vault";
pub const VAULT_TOKEN_SEED: &[u8] = b"vault_token";
pub const POSITION_SEED: &[u8] = b"position";

#[program]
pub mod test_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.mint = ctx.accounts.mint.key();
        vault.bump = ctx.bumps.vault;
        vault.total_deposits = 0;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require_scope_open(
            ctx.accounts.breakglass_program.to_account_info(),
            ctx.accounts.bg_config.to_account_info(),
            ctx.accounts.bg_pause_state.to_account_info(),
            scopes::DEPOSIT,
        )?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.user_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.user.key();
        position.vault = ctx.accounts.vault.key();
        position.amount = position
            .amount
            .checked_add(amount)
            .ok_or(VaultError::Math)?;
        let vault = &mut ctx.accounts.vault;
        vault.total_deposits = vault
            .total_deposits
            .checked_add(amount)
            .ok_or(VaultError::Math)?;
        Ok(())
    }

    /// Gated by `check_outflow(WITHDRAW)`:
    /// Allow -> transfer now. Hold -> a PendingWithdrawal is created, the amount
    /// leaves the user's position (still owed, so `total_deposits` is unchanged)
    /// and nothing moves until `claim_held`. Paused -> fails with ScopePaused.
    /// `hold_nonce` names the hold account in case of Hold; pick an unused one.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64, hold_nonce: u64) -> Result<()> {
        #[cfg(not(feature = "planted-bug"))]
        require!(
            ctx.accounts.position.amount >= amount,
            VaultError::InsufficientPosition
        );

        let a = &ctx.accounts;
        let decision = breakglass_sdk::check_outflow(
            &gate(
                &a.breakglass_program,
                &a.bg_event_authority,
                &a.gate_signer,
                ctx.bumps.gate_signer,
                &a.bg_config,
            ),
            &Outflow {
                pause_state: a.bg_pause_state.to_account_info(),
                flow_limiter: a.bg_flow_limiter.to_account_info(),
                vault: a.vault_token.to_account_info(),
                hold: a.bg_hold.to_account_info(),
            },
            a.user.to_account_info(),
            a.system_program.to_account_info(),
            scopes::WITHDRAW,
            amount,
            a.user.key(),
            hold_nonce,
        )?;

        match decision {
            Decision::Allow => {
                transfer_out(
                    &ctx.accounts.vault,
                    &ctx.accounts.vault_token,
                    &ctx.accounts.mint,
                    &ctx.accounts.user_token,
                    &ctx.accounts.token_program,
                    amount,
                )?;
                let vault = &mut ctx.accounts.vault;
                vault.total_deposits = vault.total_deposits.saturating_sub(amount);
            }
            Decision::Hold => {}
            Decision::Deny => return err!(BreakglassError::ScopePaused),
        }
        let position = &mut ctx.accounts.position;
        position.amount = position.amount.saturating_sub(amount);
        Ok(())
    }

    /// The owner claims a held withdrawal once Breakglass allows it.
    /// If the claim would cross the window cap, Breakglass auto-trips the scope
    /// and this returns Ok without transferring (claim again later).
    pub fn claim_held(ctx: Context<ClaimHeld>) -> Result<()> {
        let amount = ctx.accounts.bg_hold.amount;
        let a = &ctx.accounts;
        let decision = breakglass_sdk::claim_held(
            &gate(
                &a.breakglass_program,
                &a.bg_event_authority,
                &a.gate_signer,
                ctx.bumps.gate_signer,
                &a.bg_config,
            ),
            &Outflow {
                pause_state: a.bg_pause_state.to_account_info(),
                flow_limiter: a.bg_flow_limiter.to_account_info(),
                vault: a.vault_token.to_account_info(),
                hold: a.bg_hold.to_account_info(),
            },
            a.user.to_account_info(),
        )?;
        if decision != Decision::Allow {
            return Ok(());
        }
        transfer_out(
            &ctx.accounts.vault,
            &ctx.accounts.vault_token,
            &ctx.accounts.mint,
            &ctx.accounts.user_token,
            &ctx.accounts.token_program,
            amount,
        )?;
        let vault = &mut ctx.accounts.vault;
        vault.total_deposits = vault.total_deposits.saturating_sub(amount);
        Ok(())
    }

    /// The Breakglass admin rejects a hold; the amount goes back to the
    /// owner's position.
    pub fn reject_held(ctx: Context<RejectHeld>) -> Result<()> {
        let amount = ctx.accounts.bg_hold.amount;
        let a = &ctx.accounts;
        breakglass_sdk::reject_held(
            &gate(
                &a.breakglass_program,
                &a.bg_event_authority,
                &a.gate_signer,
                ctx.bumps.gate_signer,
                &a.bg_config,
            ),
            a.admin.to_account_info(),
            a.bg_hold.to_account_info(),
        )?;
        let position = &mut ctx.accounts.position;
        position.amount = position
            .amount
            .checked_add(amount)
            .ok_or(VaultError::Math)?;
        Ok(())
    }
}

fn gate<'info>(
    breakglass_program: &Program<'info, Breakglass>,
    event_authority: &UncheckedAccount<'info>,
    gate_signer: &UncheckedAccount<'info>,
    gate_signer_bump: u8,
    config: &Account<'info, ProtocolConfig>,
) -> Gate<'info> {
    Gate {
        breakglass_program: breakglass_program.to_account_info(),
        event_authority: event_authority.to_account_info(),
        gate_signer: gate_signer.to_account_info(),
        gate_signer_bump,
        config: config.to_account_info(),
    }
}

fn transfer_out<'info>(
    vault: &Account<'info, Vault>,
    vault_token: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    to: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    amount: u64,
) -> Result<()> {
    let mint_key = vault.mint;
    let seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &[vault.bump]];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            TransferChecked {
                from: vault_token.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: vault.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        mint.decimals,
    )
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub mint: Pubkey,
    pub bump: u8,
    pub total_deposits: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = payer, space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, mint.key().as_ref()], bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init, payer = payer,
        seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()], bump,
        token::mint = mint, token::authority = vault
    )]
    pub vault_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Breakglass accounts every gated instruction carries. The constraint on
/// `bg_config` is what makes the gate fail closed: it must be *this* program's config.
#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump, has_one = mint)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()], bump)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, vault.key().as_ref(), user.key().as_ref()], bump
    )]
    pub position: Account<'info, Position>,

    #[account(constraint = bg_config.protected_program == crate::ID @ VaultError::WrongBreakglassConfig)]
    pub bg_config: Account<'info, ProtocolConfig>,
    /// CHECK: seeds and owner verified inside breakglass::check_scope.
    pub bg_pause_state: UncheckedAccount<'info>,
    pub breakglass_program: Program<'info, Breakglass>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

/// Breakglass accounts for the outflow gate. `bg_config` is constrained to
/// this program; Breakglass checks owner and seeds of the rest (fail closed).
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump, has_one = mint)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()], bump)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref(), user.key().as_ref()], bump,
        constraint = position.owner == user.key()
    )]
    pub position: Account<'info, Position>,

    #[account(constraint = bg_config.protected_program == crate::ID @ VaultError::WrongBreakglassConfig)]
    pub bg_config: Account<'info, ProtocolConfig>,
    /// CHECK: owner and seeds verified by breakglass::check_outflow.
    #[account(mut)]
    pub bg_pause_state: UncheckedAccount<'info>,
    /// CHECK: owner and seeds verified by breakglass::check_outflow.
    #[account(mut)]
    pub bg_flow_limiter: UncheckedAccount<'info>,
    /// CHECK: PendingWithdrawal PDA, created by breakglass::check_outflow on Hold.
    #[account(mut)]
    pub bg_hold: UncheckedAccount<'info>,
    /// CHECK: Breakglass event authority, verified by Breakglass.
    pub bg_event_authority: UncheckedAccount<'info>,
    /// CHECK: this program's gate signer PDA; signs the CPI.
    #[account(seeds = [GATE_SIGNER_SEED], bump)]
    pub gate_signer: UncheckedAccount<'info>,
    pub breakglass_program: Program<'info, Breakglass>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimHeld<'info> {
    pub user: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump, has_one = mint)]
    pub vault: Account<'info, Vault>,
    #[account(mut, seeds = [VAULT_TOKEN_SEED, vault.key().as_ref()], bump)]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub user_token: Account<'info, TokenAccount>,

    #[account(constraint = bg_config.protected_program == crate::ID @ VaultError::WrongBreakglassConfig)]
    pub bg_config: Account<'info, ProtocolConfig>,
    /// CHECK: owner and seeds verified by breakglass::claim_held.
    #[account(mut)]
    pub bg_pause_state: UncheckedAccount<'info>,
    /// CHECK: owner and seeds verified by breakglass::claim_held.
    #[account(mut)]
    pub bg_flow_limiter: UncheckedAccount<'info>,
    /// Owner checked by Anchor (Breakglass account); seeds by breakglass::claim_held.
    #[account(
        mut,
        constraint = bg_hold.owner == user.key() @ VaultError::WrongHold,
        constraint = bg_hold.mint == mint.key() @ VaultError::WrongHold,
        constraint = bg_hold.config == bg_config.key() @ VaultError::WrongHold
    )]
    pub bg_hold: Account<'info, PendingWithdrawal>,
    /// CHECK: Breakglass event authority, verified by Breakglass.
    pub bg_event_authority: UncheckedAccount<'info>,
    /// CHECK: this program's gate signer PDA; signs the CPI.
    #[account(seeds = [GATE_SIGNER_SEED], bump)]
    pub gate_signer: UncheckedAccount<'info>,
    pub breakglass_program: Program<'info, Breakglass>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RejectHeld<'info> {
    /// Must be the Breakglass admin (checked by Breakglass).
    pub admin: Signer<'info>,
    #[account(seeds = [VAULT_SEED, bg_hold.mint.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref(), bg_hold.owner.as_ref()], bump,
        constraint = position.owner == bg_hold.owner @ VaultError::WrongHold
    )]
    pub position: Account<'info, Position>,

    #[account(constraint = bg_config.protected_program == crate::ID @ VaultError::WrongBreakglassConfig)]
    pub bg_config: Account<'info, ProtocolConfig>,
    #[account(mut, constraint = bg_hold.config == bg_config.key() @ VaultError::WrongHold)]
    pub bg_hold: Account<'info, PendingWithdrawal>,
    /// CHECK: Breakglass event authority, verified by Breakglass.
    pub bg_event_authority: UncheckedAccount<'info>,
    /// CHECK: this program's gate signer PDA; signs the CPI.
    #[account(seeds = [GATE_SIGNER_SEED], bump)]
    pub gate_signer: UncheckedAccount<'info>,
    pub breakglass_program: Program<'info, Breakglass>,
}

#[error_code]
pub enum VaultError {
    #[msg("Withdraw exceeds user position")]
    InsufficientPosition,
    #[msg("Breakglass config does not belong to this program")]
    WrongBreakglassConfig,
    #[msg("Arithmetic error")]
    Math,
    #[msg("Hold does not belong to this user, mint or config")]
    WrongHold,
}
