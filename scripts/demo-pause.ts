// Phase 1 manual check: pause WITHDRAW, watch a withdraw fail, unpause, withdraw again.
//
//   solana-test-validator --reset        # terminal 1
//   anchor deploy                        # terminal 2
//   yarn ts-node scripts/demo-pause.ts
//
// Uses ANCHOR_PROVIDER_URL (default http://127.0.0.1:8899) and ANCHOR_WALLET
// (default ~/.config/solana/id.json). The wallet is the Breakglass admin: the
// script registers test-vault if needed, and pauses as the admin so it can be
// re-run (a guardian would hit its 6h cooldown on the second run).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { Breakglass } from "../target/types/breakglass";
import { TestVault } from "../target/types/test_vault";
import { parseBreakglassError } from "../clients/ts/src/errors";

const WITHDRAW = 1;
const REPAY = 3;

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const walletPath =
    process.env.ANCHOR_WALLET ??
    path.join(os.homedir(), ".config/solana/id.json");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
  );
  const connection = new Connection(url, "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
  });

  const idlDir = path.join(__dirname, "../target/idl");
  const bg = new Program<Breakglass>(
    JSON.parse(fs.readFileSync(path.join(idlDir, "breakglass.json"), "utf8")),
    provider,
  );
  const vaultProgram = new Program<TestVault>(
    JSON.parse(fs.readFileSync(path.join(idlDir, "test_vault.json"), "utf8")),
    provider,
  );
  for (const p of [bg.programId, vaultProgram.programId]) {
    if (!(await connection.getAccountInfo(p))?.executable) {
      throw new Error(
        `program ${p.toBase58()} is not deployed at ${url}: run 'anchor deploy'`,
      );
    }
  }

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), vaultProgram.programId.toBuffer()],
    bg.programId,
  );
  const [pauseState] = PublicKey.findProgramAddressSync(
    [Buffer.from("pause"), config.toBuffer()],
    bg.programId,
  );
  const [ledger] = PublicKey.findProgramAddressSync(
    [Buffer.from("gledger"), config.toBuffer(), payer.publicKey.toBuffer()],
    bg.programId,
  );

  // 1. Register test-vault with Breakglass (once per validator).
  const existing = await bg.account.protocolConfig.fetchNullable(config);
  if (!existing) {
    await bg.methods
      .initializeConfig({
        guardians: [],
        unpausableMask: new BN(1).shln(REPAY),
        timelockSecs: null,
      })
      .accounts({
        payer: payer.publicKey,
        admin: payer.publicKey,
        protectedProgram: vaultProgram.programId,
      })
      .rpc();
    console.log(`registered test-vault, config ${config.toBase58()}`);
  } else if (!existing.admin.equals(payer.publicKey)) {
    throw new Error(
      `config admin is ${existing.admin.toBase58()}, not this wallet`,
    );
  }

  // 2. A fresh vault with a user who has deposited.
  const user = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(user.publicKey, LAMPORTS_PER_SOL),
    "confirmed",
  );
  const mint = await createMint(connection, payer, payer.publicKey, null, 6);
  await vaultProgram.methods
    .initializeVault()
    .accountsPartial({ payer: payer.publicKey, mint })
    .rpc();
  const userToken = (
    await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      user.publicKey,
    )
  ).address;
  await mintTo(connection, payer, mint, userToken, payer, 1_000_000_000);
  const gate = {
    mint,
    userToken,
    bgConfig: config,
    bgPauseState: pauseState,
    user: user.publicKey,
  };
  await vaultProgram.methods
    .deposit(new BN(1_000_000_000))
    .accountsPartial(gate)
    .signers([user])
    .rpc();
  console.log("deposited 1000 tokens");

  const withdraw = () =>
    vaultProgram.methods
      .withdraw(new BN(100_000_000))
      .accountsPartial(gate)
      .signers([user])
      .rpc();
  const withdrawMask = new BN(1).shln(WITHDRAW);

  // 3. Pause WITHDRAW for 10 minutes.
  await bg.methods
    .pause(withdrawMask, new BN(600), 1)
    .accountsPartial({
      authority: payer.publicKey,
      config,
      pauseState,
      guardianLedger: ledger,
    })
    .rpc();
  console.log("paused WITHDRAW for 600s");

  // 4. The withdraw is blocked by the gate.
  try {
    await withdraw();
    throw new Error("withdraw went through while paused");
  } catch (e) {
    const err = parseBreakglassError(e);
    if (!err) throw e;
    console.log(`withdraw blocked: ${err.name}`);
  }

  // 5. Unpause and withdraw again.
  await bg.methods
    .unpause(withdrawMask)
    .accountsPartial({ authority: payer.publicKey, config, pauseState })
    .rpc();
  console.log("unpaused WITHDRAW");
  await withdraw();
  console.log("withdraw ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
