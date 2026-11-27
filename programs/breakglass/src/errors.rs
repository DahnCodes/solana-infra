use anchor_lang::prelude::*;

#[error_code]
pub enum BreakglassError {
    #[msg("Scope is paused")]
    ScopePaused,
    #[msg("Scope id out of range (0..64)")]
    InvalidScope,
    #[msg("Scope is marked unpausable")]
    ScopeUnpausable,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Too many guardians")]
    TooManyGuardians,
    #[msg("Pause duration exceeds the guardian maximum")]
    PauseTooLong,
    #[msg("Guardian renewal cap reached; admin must extend")]
    RenewCapReached,
    #[msg("Guardian is in cooldown")]
    GuardianCooldown,
    #[msg("Guardian pause budget for this period is used up")]
    PauseBudgetExhausted,
    #[msg("Too many active pauses")]
    TooManyActivePauses,
    #[msg("Held withdrawal is not released yet")]
    HoldNotReleased,
    #[msg("Held withdrawal is frozen")]
    HoldFrozen,
    #[msg("Held withdrawal is not in a claimable state")]
    HoldInvalidState,
    #[msg("Caller is not the registered protected program")]
    InvalidCaller,
    #[msg("Timelock is still active")]
    TimelockActive,
    #[msg("Timelock value out of allowed range")]
    InvalidTimelock,
    #[msg("Pending change was vetoed")]
    Vetoed,
    #[msg("Protocol invariant violated")]
    InvariantViolated,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Account is not executable")]
    NotExecutable,
    // Phase 1 (append only)
    #[msg("Scope is not paused")]
    ScopeNotPaused,
    #[msg("Pause duration must be positive")]
    InvalidDuration,
    #[msg("Key is not a guardian of this config")]
    GuardianNotFound,
    // Phase 2 (append only)
    #[msg("Flow limiter parameters out of range")]
    InvalidLimiterConfig,
    #[msg("Vault token account does not match the flow limiter")]
    WrongVault,
    #[msg("Hold account does not match its seeds, owner, mint or limiter")]
    WrongHold,
}
