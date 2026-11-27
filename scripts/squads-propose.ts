// Phase 4: run `propose_config` through a Squads v4 multisig, with the Squads
// vault PDA as the Breakglass admin (the recommended setup, docs/SPEC.md
// "Relationship to Squads").
//
// Devnet (default):
//   anchor deploy --provider.cluster devnet          # Breakglass + test-vault on devnet
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com yarn ts-node scripts/squads-propose.ts
//
// What it does:
//   1. Creates a 1-of-1 Squads multisig with your wallet as the only member,
//      or reuses SQUADS_MULTISIG=<multisig address>.
//   2. Registers test-vault with Breakglass, admin = the multisig's vault 0
//      (your wallet signs as test-vault's upgrade authority), unless it's
//      already registered with that vault as admin.
//   3. Wraps `propose_config(AddGuardian <random key>)` in a Squads vault
//      transaction, then creates, approves and executes the proposal.
//   4. Prints the queued PendingConfig and when it becomes executable.
//
// Uses ANCHOR_WALLET (default ~/.config/solana/id.json). Needs a little SOL
// (devnet: `solana airdrop 2`).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { Breakglass } from "../target/types/breakglass";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

async function main() {
  const url =
    process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const me = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
  const connection = new Connection(url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(me), {
    commitment: "confirmed",
  });
  const idl = (name: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, `../target/idl/${name}.json`),
        "utf8",
      ),
    );
  const bg = new Program<Breakglass>(idl("breakglass"), provider);
  const testVaultId = new PublicKey(idl("test_vault").address);
  const confirm = async (sig: string) => {
    await connection.confirmTransaction(
      { signature: sig, ...(await connection.getLatestBlockhash()) },
      "confirmed",
    );
    return sig;
  };

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), testVaultId.toBuffer()],
    bg.programId,
  );
  const existing = await bg.account.protocolConfig.fetchNullable(config);
  if (existing && !process.env.SQUADS_MULTISIG) {
    throw new Error(
      `test-vault is already registered (admin ${existing.admin.toBase58()}). ` +
        "Run with SQUADS_MULTISIG=<the multisig whose vault 0 is that admin>, " +
        "or use a fresh cluster (localnet: solana-test-validator --reset).",
    );
  }

  // 1. The multisig and its vault.
  let multisigPda: PublicKey;
  if (process.env.SQUADS_MULTISIG) {
    multisigPda = new PublicKey(process.env.SQUADS_MULTISIG);
    console.log(`using multisig ${multisigPda.toBase58()}`);
  } else {
    const createKey = Keypair.generate();
    [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfig =
      await multisig.accounts.ProgramConfig.fromAccountAddress(
        connection,
        programConfigPda,
      );
    await confirm(
      await multisig.rpc.multisigCreateV2({
        connection,
        treasury: programConfig.treasury,
        createKey,
        creator: me,
        multisigPda,
        configAuthority: null,
        threshold: 1,
        members: [
          { key: me.publicKey, permissions: multisig.types.Permissions.all() },
        ],
        timeLock: 0,
        rentCollector: null,
      }),
    );
    console.log(
      `created 1-of-1 multisig ${multisigPda.toBase58()} (reuse with SQUADS_MULTISIG=...)`,
    );
  }
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  console.log(`Squads vault (Breakglass admin): ${vaultPda.toBase58()}`);

  // The vault pays for the PendingConfig account it creates.
  if ((await connection.getBalance(vaultPda)) < 0.02 * LAMPORTS_PER_SOL) {
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: me.publicKey,
          toPubkey: vaultPda,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        }),
      ),
    );
  }

  // 2. test-vault registered with the vault as admin.
  if (!existing) {
    await bg.methods
      .initializeConfig({
        guardians: [],
        unpausableMask: new BN(8),
        timelockSecs: null,
      })
      .accountsPartial({
        payer: me.publicKey,
        admin: vaultPda,
        upgradeAuthority: me.publicKey,
        protectedProgram: testVaultId,
        protectedProgramData: PublicKey.findProgramAddressSync(
          [testVaultId.toBuffer()],
          BPF_LOADER_UPGRADEABLE,
        )[0],
      })
      .rpc();
    console.log(
      `registered test-vault, config ${config.toBase58()}, admin = Squads vault`,
    );
  } else if (!existing.admin.equals(vaultPda)) {
    throw new Error(
      `test-vault is already registered with admin ${existing.admin.toBase58()}. ` +
        "Run with SQUADS_MULTISIG=<the multisig whose vault 0 is that admin>, " +
        "or use a fresh cluster (localnet: solana-test-validator --reset).",
    );
  }

  // 3. propose_config, signed by the vault through Squads.
  const nextId = (await bg.account.protocolConfig.fetch(config)).nextChangeId;
  const [pending] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("cfgchg"),
      config.toBuffer(),
      nextId.toArrayLike(Buffer, "le", 8),
    ],
    bg.programId,
  );
  const newGuardian = Keypair.generate().publicKey;
  const proposeIx = await bg.methods
    .proposeConfig({ addGuardian: { guardian: newGuardian } })
    .accountsPartial({ payer: vaultPda, admin: vaultPda, config, pending })
    .instruction();

  const ms = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const message = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [proposeIx],
  });
  await confirm(
    await multisig.rpc.vaultTransactionCreate({
      connection,
      feePayer: me,
      multisigPda,
      transactionIndex,
      creator: me.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo: "Breakglass propose_config(AddGuardian)",
    }),
  );
  await confirm(
    await multisig.rpc.proposalCreate({
      connection,
      feePayer: me,
      creator: me,
      multisigPda,
      transactionIndex,
    }),
  );
  await confirm(
    await multisig.rpc.proposalApprove({
      connection,
      feePayer: me,
      member: me,
      multisigPda,
      transactionIndex,
    }),
  );
  const execSig = await confirm(
    await multisig.rpc.vaultTransactionExecute({
      connection,
      feePayer: me,
      multisigPda,
      transactionIndex,
      member: me.publicKey,
    }),
  );
  console.log(
    `Squads proposal #${transactionIndex} approved and executed: ${execSig}`,
  );

  // 4. The queued Breakglass change.
  const p = await bg.account.pendingConfig.fetch(pending);
  const at = new Date(p.executableAt.toNumber() * 1000).toISOString();
  console.log(`queued Breakglass change ${pending.toBase58()}`);
  console.log(`  action: AddGuardian ${newGuardian.toBase58()}`);
  console.log(`  proposed by: ${p.proposedBy.toBase58()} (the Squads vault)`);
  console.log(`  executable at: ${at} (guardians can veto until then)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
