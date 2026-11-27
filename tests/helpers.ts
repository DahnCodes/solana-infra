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

export function initConfig() {
  return breakglass.methods
    .initializeConfig({
      guardians: guardians.map((g) => g.publicKey),
      unpausableMask: UNPAUSABLE_MASK,
      timelockSecs: null,
    })
    .accounts({
      payer: provider.wallet.publicKey,
      admin: provider.wallet.publicKey,
      protectedProgram: testVault.programId,
    })
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
  user: Keypair;
  userToken: PublicKey;
}

/** A fresh mint + vault, and a funded user holding `minted` tokens. */
export async function createVault(minted = 1_000_000): Promise<VaultFixture> {
  const user = Keypair.generate();
  await fund(user.publicKey);
  const mint = await createMint(connection, admin, admin.publicKey, null, 6);
  await testVault.methods
    .initializeVault()
    .accountsPartial({ payer: admin.publicKey, mint })
    .rpc({ commitment: "confirmed" });
  const ata = await getOrCreateAssociatedTokenAccount(
    connection,
    admin,
    mint,
    user.publicKey,
  );
  await mintTo(connection, admin, mint, ata.address, admin, minted);
  return { mint, user, userToken: ata.address };
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

export function withdraw(v: VaultFixture, amount: number) {
  return testVault.methods
    .withdraw(new BN(amount))
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

export async function tokenBalance(account: PublicKey): Promise<bigint> {
  return (await getAccount(connection, account, "confirmed")).amount;
}

// ---- assertions -----------------------------------------------------------

/**
 * Expect a transaction to fail with Breakglass error `name`. Also checks the
 * numeric code against the client's error table (clients/ts/src/errors.ts).
 */
export async function expectError(p: Promise<unknown>, name: string) {
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
