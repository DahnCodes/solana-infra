import { PublicKey } from "@solana/web3.js";
import { SEEDS } from "./constants";

// Every Breakglass account is a PDA of the Breakglass program. These helpers
// derive the same addresses the program checks, so a frontend never has to
// hand-build seeds.

const enc = (s: string) => Buffer.from(s, "utf8");

/** u64 little-endian, as the program writes `nonce.to_le_bytes()` / `id.to_le_bytes()`. */
export function u64Le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

/** ["config", protected_program] */
export function findConfigPda(
  breakglassProgramId: PublicKey,
  protectedProgram: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.config), protectedProgram.toBuffer()],
    breakglassProgramId,
  );
}

/** ["pause", config] */
export function findPauseStatePda(
  breakglassProgramId: PublicKey,
  config: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.pause), config.toBuffer()],
    breakglassProgramId,
  );
}

/** ["flow", config, mint]: the outflow limiter of one mint. */
export function findFlowLimiterPda(
  breakglassProgramId: PublicKey,
  config: PublicKey,
  mint: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.flow), config.toBuffer(), mint.toBuffer()],
    breakglassProgramId,
  );
}

/** ["hold", config, owner, nonce_u64_le]: a held withdrawal. The protocol picks the nonce. */
export function findPendingWithdrawalPda(
  breakglassProgramId: PublicKey,
  config: PublicKey,
  owner: PublicKey,
  nonce: bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.hold), config.toBuffer(), owner.toBuffer(), u64Le(nonce)],
    breakglassProgramId,
  );
}

/** ["gledger", config, guardian]: pause budget and cooldown of one guardian. */
export function findGuardianLedgerPda(
  breakglassProgramId: PublicKey,
  config: PublicKey,
  guardian: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.guardianLedger), config.toBuffer(), guardian.toBuffer()],
    breakglassProgramId,
  );
}

/**
 * ["breakglass-gate"] under the *protected* program: the PDA that program
 * signs `check_outflow` / `claim_held` / `reject_held` with.
 */
export function findGateSignerPda(protectedProgram: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc(SEEDS.gateSigner)], protectedProgram);
}

/** Anchor's ["__event_authority"] PDA of Breakglass (needed by every CPI that emits events). */
export function findEventAuthorityPda(breakglassProgramId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc("__event_authority")], breakglassProgramId);
}

/** ["cfgchg", config, id_u64_le] (Phase 4) */
export function findPendingConfigPda(
  breakglassProgramId: PublicKey,
  config: PublicKey,
  id: bigint | number,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [enc(SEEDS.configChange), config.toBuffer(), u64Le(id)],
    breakglassProgramId,
  );
}

/** All the PDAs a protocol's dashboard needs, in one call. */
export function protocolAddresses(
  breakglassProgramId: PublicKey,
  protectedProgram: PublicKey,
) {
  const [config] = findConfigPda(breakglassProgramId, protectedProgram);
  const [pauseState] = findPauseStatePda(breakglassProgramId, config);
  return { config, pauseState };
}

/**
 * The Breakglass accounts a protected program's withdraw needs for one mint,
 * plus a fresh hold PDA for `owner` (random nonce unless given). Pass them to
 * the protocol's instruction under its own account names.
 */
export function outflowAccounts(
  breakglassProgramId: PublicKey,
  protectedProgram: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  nonce?: bigint,
) {
  const { config, pauseState } = protocolAddresses(breakglassProgramId, protectedProgram);
  const [flowLimiter] = findFlowLimiterPda(breakglassProgramId, config, mint);
  const holdNonce = nonce ?? randomNonce();
  const [hold] = findPendingWithdrawalPda(breakglassProgramId, config, owner, holdNonce);
  const [eventAuthority] = findEventAuthorityPda(breakglassProgramId);
  const [gateSigner] = findGateSignerPda(protectedProgram);
  return { config, pauseState, flowLimiter, hold, holdNonce, eventAuthority, gateSigner };
}

/** A random u64 hold nonce (collisions are astronomically unlikely). */
export function randomNonce(): bigint {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
  return Buffer.from(b).readBigUInt64LE();
}

/** The accounts `pause` / `renew_pause` take for a given signer (guardian or admin). */
export function pauseAccounts(
  breakglassProgramId: PublicKey,
  protectedProgram: PublicKey,
  authority: PublicKey,
) {
  const { config, pauseState } = protocolAddresses(breakglassProgramId, protectedProgram);
  const [guardianLedger] = findGuardianLedgerPda(breakglassProgramId, config, authority);
  return { authority, config, pauseState, guardianLedger };
}
