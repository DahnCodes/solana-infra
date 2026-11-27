// Shared fixture for the integration tests. Every test file imports this, so
// the config, guardians and vault are created once per `anchor test` run
// (one config per protected program, and test-vault is the only one).

import * as anchor from "@coral-xyz/anchor";
import { BN, BorshEventCoder, Program, utils } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { Breakglass } from "../target/types/breakglass";
import { TestVault } from "../target/types/test_vault";
import { breakglassError } from "../clients/ts/src/errors";

export const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
export const connection = provider.connection;

export const breakglass = anchor.workspace.Breakglass as Program<Breakglass>;
export const testVault = anchor.workspace.TestVault as Program<TestVault>;

export const admin = (provider.wallet as anchor.Wallet).payer;

/** Five guardians (the max). Tests use different ones so cooldowns don't collide. */
export const guardians = Array.from({ length: 5 }, () => Keypair.generate());

export const SCOPE = { DEPOSIT: 0, WITHDRAW: 1, BORROW: 2, REPAY: 3 } as const;
export const UNPAUSABLE_MASK = new BN(1).shln(SCOPE.REPAY);
export const HOUR = 3600;

export function mask(...scopes: number[]): BN {
  return scopes.reduce((m, s) => m.or(new BN(1).shln(s)), new BN(0));
}

export const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config"), testVault.programId.toBuffer()],
  breakglass.programId,
);
export const [pausePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("pause"), configPda.toBuffer()],
  breakglass.programId,
);
export function ledgerPda(guardian: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gledger"), configPda.toBuffer(), guardian.toBuffer()],
    breakglass.programId,
  )[0];
}

export async function fund(...keys: PublicKey[]) {
  for (const k of keys) {
    const sig = await connection.requestAirdrop(k, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
}

export const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
export function programDataPda(program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [program.toBuffer()],
    BPF_LOADER_UPGRADEABLE,
  )[0];
}

/** Register `protectedProgram` (default test-vault); the wallet is its upgrade authority. */
export function initConfig(
  protectedProgram: PublicKey = testVault.programId,
  upgradeAuthority: Keypair = admin,
) {
  return breakglass.methods
    .initializeConfig({
      guardians: guardians.map((g) => g.publicKey),
      unpausableMask: UNPAUSABLE_MASK,
      timelockSecs: null,
    })
    .accountsPartial({
      payer: provider.wallet.publicKey,
      admin: provider.wallet.publicKey,
      upgradeAuthority: upgradeAuthority.publicKey,
      protectedProgram,
      protectedProgramData: programDataPda(protectedProgram),
    })
    .signers(upgradeAuthority === admin ? [] : [upgradeAuthority])
    .rpc({ commitment: "confirmed" });
}

let ready: Promise<void> | undefined;
/** Config initialized (by breakglass.ts, or here if run alone) and guardians funded. */
export function ensureConfig(): Promise<void> {
  ready ??= (async () => {
    if (!(await connection.getAccountInfo(configPda))) await initConfig();
    await fund(...guardians.map((g) => g.publicKey));
  })();
  return ready;
}

// ---- Breakglass instructions, signed by any key ---------------------------

export function pause(
  signer: Keypair,
  scopes: BN,
  duration: number,
  reason = 0,
) {
  return breakglass.methods
    .pause(scopes, new BN(duration), reason)
    .accountsPartial({
      authority: signer.publicKey,
      config: configPda,
      pauseState: pausePda,
      guardianLedger: ledgerPda(signer.publicKey),
    })
    .signers([signer])
    .rpc({ commitment: "confirmed" });
}

export function renewPause(signer: Keypair, scopes: BN) {
  return breakglass.methods
    .renewPause(scopes)
    .accountsPartial({
      authority: signer.publicKey,
      config: configPda,
      pauseState: pausePda,
      guardianLedger: ledgerPda(signer.publicKey),
    })
    .signers([signer])
    .rpc({ commitment: "confirmed" });
}

export function unpause(signer: Keypair, scopes: BN) {
  return breakglass.methods
    .unpause(scopes)
    .accountsPartial({
      authority: signer.publicKey,
      config: configPda,
      pauseState: pausePda,
    })
    .signers([signer])
    .rpc({ commitment: "confirmed" });
}

export function removeGuardian(signer: Keypair, guardian: PublicKey) {
  return breakglass.methods
    .removeGuardian(guardian)
    .accountsPartial({ admin: signer.publicKey, config: configPda })
    .signers([signer])
    .rpc({ commitment: "confirmed" });
}

// ---- test-vault -----------------------------------------------------------

export interface VaultFixture {
  mint: PublicKey;
  vault: PublicKey;
  vaultToken: PublicKey;
  limiter: PublicKey;
  user: Keypair;
  userToken: PublicKey;
}

export const [eventAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  breakglass.programId,
);
export const [gateSignerPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("breakglass-gate")],
  testVault.programId,
);

export function limiterPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("flow"), configPda.toBuffer(), mint.toBuffer()],
    breakglass.programId,
  )[0];
}

export function holdPda(owner: PublicKey, nonce: BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("hold"),
      configPda.toBuffer(),
      owner.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    breakglass.programId,
  )[0];
}

let nonceCounter = new BN(Date.now()).muln(1000);
/** A hold nonce not used before in this run. */
export function nextNonce(): BN {
  nonceCounter = nonceCounter.addn(1);
  return nonceCounter.clone();
}

export interface LimiterParams {
  windowSecs: BN | null;
  capAbsolute: BN;
  capBpsOfVault: number;
  largeThreshold: BN;
  largeThresholdBps: number;
  holdSecs: BN | null;
  autoTripSecs: BN | null;
  instantAllowance: BN | null;
  screenSecs: BN | null;
}

/** Generous by default: nothing is held or tripped unless a test asks for it. */
export function limiterParams(
  over: Partial<LimiterParams> = {},
): LimiterParams & { scope: number } {
  return {
    scope: SCOPE.WITHDRAW,
    windowSecs: null,
    capAbsolute: new BN("1000000000000"),
    capBpsOfVault: 0,
    largeThreshold: new BN("1000000000000"),
    largeThresholdBps: 0,
    holdSecs: null,
    autoTripSecs: null,
    instantAllowance: null,
    screenSecs: null,
    ...over,
  };
}

export function initLimiter(
  signer: Keypair,
  mint: PublicKey,
  vaultToken: PublicKey,
  params: LimiterParams & { scope: number },
) {
  return breakglass.methods
    .initFlowLimiter(params)
    .accountsPartial({
      admin: signer.publicKey,
      config: configPda,
      mint,
      vault: vaultToken,
      flowLimiter: limiterPda(mint),
    })
    .signers(signer === admin ? [] : [signer])
    .rpc({ commitment: "confirmed" });
}

/**
 * A fresh mint + vault with its flow limiter, and a funded user holding
 * `minted` tokens. Pass `limiter: null` to skip creating the limiter.
 */
export async function createVault(
  opts: {
    minted?: number;
    limiter?: Partial<LimiterParams> | null;
    /** Only a planted-bug build accepts this (InvariantsRequired otherwise). */
    invariantsOff?: boolean;
  } = {},
): Promise<VaultFixture> {
  const user = Keypair.generate();
  await fund(user.publicKey);
  const mint = await createMint(connection, admin, admin.publicKey, null, 6);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), mint.toBuffer()],
    testVault.programId,
  );
  const [vaultToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token"), vault.toBuffer()],
    testVault.programId,
  );
  await testVault.methods
    .initializeVault(opts.invariantsOff ?? false)
    .accountsPartial({ payer: admin.publicKey, mint })
    .rpc({ commitment: "confirmed" });
  if (opts.limiter !== null) {
    await initLimiter(admin, mint, vaultToken, limiterParams(opts.limiter));
  }
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    mint,
    user.publicKey,
  );
  await mintTo(
    connection,
    admin,
    mint,
    ata.address,
    admin,
    opts.minted ?? 1_000_000,
  );
  return {
    mint,
    vault,
    vaultToken,
    limiter: limiterPda(mint),
    user,
    userToken: ata.address,
  };
}

/** Another funded user of the same vault, holding `minted` tokens. */
export async function newUser(
  v: VaultFixture,
  minted = 1_000_000,
): Promise<VaultFixture> {
  const user = Keypair.generate();
  await fund(user.publicKey);
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    v.mint,
    user.publicKey,
  );
  await mintTo(connection, admin, v.mint, ata.address, admin, minted);
  return { ...v, user, userToken: ata.address };
}

export function deposit(v: VaultFixture, amount: number) {
  return testVault.methods
    .deposit(new BN(amount))
    .accountsPartial({
      user: v.user.publicKey,
      mint: v.mint,
      userToken: v.userToken,
      bgConfig: configPda,
      bgPauseState: pausePda,
    })
    .signers([v.user])
    .rpc({ commitment: "confirmed" });
}

/** test-vault withdraw accounts, all explicit so tests can swap any of them. */
export function withdrawAccounts(v: VaultFixture, nonce: BN) {
  return {
    user: v.user.publicKey,
    mint: v.mint,
    vault: v.vault,
    vaultToken: v.vaultToken,
    userToken: v.userToken,
    bgConfig: configPda,
    bgPauseState: pausePda,
    bgFlowLimiter: v.limiter,
    bgHold: holdPda(v.user.publicKey, nonce),
    bgEventAuthority: eventAuthorityPda,
    gateSigner: gateSignerPda,
  };
}

export function withdrawIx(v: VaultFixture, amount: number, nonce: BN) {
  return testVault.methods
    .withdraw(new BN(amount), nonce)
    .accountsPartial(withdrawAccounts(v, nonce))
    .instruction();
}

export function withdraw(v: VaultFixture, amount: number, nonce = nextNonce()) {
  return testVault.methods
    .withdraw(new BN(amount), nonce)
    .accountsPartial(withdrawAccounts(v, nonce))
    .signers([v.user])
    .rpc({ commitment: "confirmed" });
}

export function claimHeld(v: VaultFixture, hold: PublicKey) {
  return testVault.methods
    .claimHeld()
    .accountsPartial({
      user: v.user.publicKey,
      mint: v.mint,
      vault: v.vault,
      vaultToken: v.vaultToken,
      userToken: v.userToken,
      position: positionPda(v),
      bgConfig: configPda,
      bgPauseState: pausePda,
      bgFlowLimiter: v.limiter,
      bgHold: hold,
      bgEventAuthority: eventAuthorityPda,
      gateSigner: gateSignerPda,
    })
    .signers([v.user])
    .rpc({ commitment: "confirmed" });
}

export function rejectHeld(signer: Keypair, v: VaultFixture, hold: PublicKey) {
  return testVault.methods
    .rejectHeld()
    .accountsPartial({
      admin: signer.publicKey,
      vault: v.vault,
      position: positionPda(v),
      bgConfig: configPda,
      bgHold: hold,
      bgEventAuthority: eventAuthorityPda,
      gateSigner: gateSignerPda,
    })
    .signers(signer === admin ? [] : [signer])
    .rpc({ commitment: "confirmed" });
}

export function freezeHeld(signer: Keypair, hold: PublicKey) {
  return breakglass.methods
    .freezeHeld()
    .accountsPartial({ authority: signer.publicKey, config: configPda, hold })
    .signers(signer === admin ? [] : [signer])
    .rpc({ commitment: "confirmed" });
}

export function positionPda(v: VaultFixture): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), v.vault.toBuffer(), v.user.publicKey.toBuffer()],
    testVault.programId,
  )[0];
}

export async function positionOf(v: VaultFixture): Promise<number> {
  return (
    await testVault.account.position.fetch(positionPda(v))
  ).amount.toNumber();
}

/** Amount in this user's held withdrawals (queued or frozen). */
export async function heldOf(v: VaultFixture): Promise<number> {
  return (
    await testVault.account.position.fetch(positionPda(v))
  ).held.toNumber();
}

export async function tokenBalance(account: PublicKey): Promise<bigint> {
  return (await getAccount(connection, account, "confirmed")).amount;
}

// ---- assertions -----------------------------------------------------------

/**
 * Expect a transaction to fail with error `name`. For Breakglass errors this
 * also checks the numeric code against the client's error table
 * (clients/ts/src/errors.ts); pass `framework: true` for Anchor's own errors
 * (e.g. AccountOwnedByWrongProgram) or another program's.
 */
export async function expectError(
  p: Promise<unknown>,
  name: string,
  opts: { framework?: boolean } = {},
) {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) expect.fail(`expected ${name}, but the transaction succeeded`);
  const logs: string[] = err.logs ?? err.transactionLogs ?? [];
  const text = [String(err.message), ...logs].join("\n");
  const got = err.error?.errorCode?.code ?? /Error Code: (\w+)/.exec(text)?.[1];
  expect(got, text).to.equal(name);
  if (opts.framework) return;
  const num =
    err.error?.errorCode?.number ??
    Number(/Error Number: (\d+)/.exec(text)?.[1]);
  expect(
    breakglassError(num)?.name,
    `client error table for code ${num}`,
  ).to.equal(name);
}

/** Breakglass events (emit_cpi!) in a confirmed transaction, decoded with the IDL. */
export async function eventsOf(
  sig: string,
): Promise<{ name: string; data: any }[]> {
  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) throw new Error(`transaction ${sig} not found`);
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses,
  });
  const coder = new BorshEventCoder(breakglass.idl);
  const out: { name: string; data: any }[] = [];
  for (const group of tx.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (!keys.get(ix.programIdIndex)?.equals(breakglass.programId)) continue;
      const raw = Buffer.from(utils.bytes.bs58.decode(ix.data));
      const ev = coder.decode(raw.subarray(8).toString("base64"));
      if (ev) out.push(ev);
    }
  }
  return out;
}

/**
 * Expect exactly one event, named as the Rust struct (`Paused`). Anchor's TS
 * coder reports names in camelCase (`paused`), so compare that form.
 */
export async function onlyEvent(sig: string, name: string): Promise<any> {
  const evs = await eventsOf(sig);
  const camel = name[0].toLowerCase() + name.slice(1);
  expect(evs.map((e) => e.name)).to.deep.equal([camel]);
  return evs[0].data;
}

// ---- clock ------------------------------------------------------------------

/** Cluster unix time, the same clock the program reads. */
export async function chainNow(): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  return (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

/** Wait until the cluster clock is strictly past `t`. */
export async function waitPast(t: number) {
  while ((await chainNow()) <= t) await new Promise((r) => setTimeout(r, 400));
}

// ---- timelocked config changes (Phase 4) ----------------------------------

export function pendingPda(id: BN | number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("cfgchg"),
      configPda.toBuffer(),
      new BN(id).toArrayLike(Buffer, "le", 8),
    ],
    breakglass.programId,
  )[0];
}

/** Propose `action` (a ConfigAction in Anchor's enum form) as `signer`. */
export async function propose(signer: Keypair, action: any) {
  const id = (await breakglass.account.protocolConfig.fetch(configPda))
    .nextChangeId;
  const pending = pendingPda(id);
  const sig = await breakglass.methods
    .proposeConfig(action)
    .accountsPartial({
      payer: signer.publicKey,
      admin: signer.publicKey,
      config: configPda,
      pending,
    })
    .signers(signer === admin ? [] : [signer])
    .rpc({ commitment: "confirmed" });
  return { sig, pending };
}

export function executeChange(
  pending: PublicKey,
  extra: { flowLimiter?: PublicKey; hold?: PublicKey } = {},
) {
  return breakglass.methods
    .executeConfig()
    .accountsPartial({
      config: configPda,
      pending,
      flowLimiter: extra.flowLimiter ?? null,
      hold: extra.hold ?? null,
    })
    .rpc({ commitment: "confirmed" });
}

export function vetoChange(signer: Keypair, pending: PublicKey) {
  return breakglass.methods
    .vetoConfig()
    .accountsPartial({ guardian: signer.publicKey, config: configPda, pending })
    .signers([signer])
    .rpc({ commitment: "confirmed" });
}

export function cancelChange(signer: Keypair, pending: PublicKey) {
  return breakglass.methods
    .cancelConfig()
    .accountsPartial({ admin: signer.publicKey, config: configPda, pending })
    .signers(signer === admin ? [] : [signer])
    .rpc({ commitment: "confirmed" });
}

/** The current settings of a limiter, as `LimiterParams`. */
export async function limiterSettings(limiter: PublicKey) {
  const l = await breakglass.account.flowLimiter.fetch(limiter);
  return {
    windowSecs: l.windowSecs,
    capAbsolute: l.capAbsolute,
    capBpsOfVault: l.capBpsOfVault,
    largeThreshold: l.largeThreshold,
    largeThresholdBps: l.largeThresholdBps,
    holdSecs: l.holdSecs,
    autoTripSecs: l.autoTripSecs,
    instantAllowance: l.instantAllowance,
    screenSecs: l.screenSecs,
  };
}

export function tightenLimits(
  signer: Keypair,
  limiter: PublicKey,
  params: any,
) {
  return breakglass.methods
    .tightenLimits(params)
    .accountsPartial({
      admin: signer.publicKey,
      config: configPda,
      flowLimiter: limiter,
    })
    .signers(signer === admin ? [] : [signer])
    .rpc({ commitment: "confirmed" });
}
