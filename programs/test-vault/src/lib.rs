//! test-vault: a minimal token vault that integrates Breakglass.
//! It exists to exercise the gate and to be attacked in tests. Never deploy to mainnet.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};
use breakglass_sdk::breakglass::{program::Breakglass, state::ProtocolConfig};
use breakglass_sdk::{require_scope_open, scopes};

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
        position.amount = position.amount.checked_add(amount).ok_or(VaultError::Math)?;
        let vault = &mut ctx.accounts.vault;
        vault.total_deposits = vault.total_deposits.checked_add(amount).ok_or(VaultError::Math)?;
        Ok(())
    }

    /// Phase 0/1: gated by `check_scope(WITHDRAW)`.
    /// Phase 2 replaces this with `check_outflow` (Allow / Hold / Deny).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        require_scope_open(
            ctx.accounts.breakglass_program.to_account_info(),
            ctx.accounts.bg_config.to_account_info(),
            ctx.accounts.bg_pause_state.to_account_info(),
            scopes::WITHDRAW,
        )?;

        #[cfg(not(feature = "planted-bug"))]
        require!(
            ctx.accounts.position.amount >= amount,
            VaultError::InsufficientPosition
        );

        let mint_key = ctx.accounts.vault.mint;
        let seeds: &[&[u8]] = &[VAULT_SEED, mint_key.as_ref(), &[ctx.accounts.vault.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.vault_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let position = &mut ctx.accounts.position;
        position.amount = position.amount.saturating_sub(amount);
        let vault = &mut ctx.accounts.vault;
        vault.total_deposits = vault.total_deposits.saturating_sub(amount);
        Ok(())
    }
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
    /// CHECK: seeds and owner verified inside breakglass::check_scope.
    pub bg_pause_state: UncheckedAccount<'info>,
    pub breakglass_program: Program<'info, Breakglass>,

    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum VaultError {
    #[msg("Withdraw exceeds user position")]
    InsufficientPosition,
    #[msg("Breakglass config does not belong to this program")]
    WrongBreakglassConfig,
    #[msg("Arithmetic error")]
    Math,
}

