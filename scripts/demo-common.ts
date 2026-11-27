// Shared setup for the demo scripts: provider from ANCHOR_PROVIDER_URL /
// ANCHOR_WALLET (defaults: local validator, ~/.config/solana/id.json), the two
// programs, test-vault registered with Breakglass (the wallet is admin and
// upgrade authority), and a fresh vault + user per run.

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

export const WITHDRAW = 1;
export const REPAY = 3;
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

export async function setup() {
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
  const idl = (name: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, `../target/idl/${name}.json`),
        "utf8",
      ),
    );
  const bg = new Program<Breakglass>(idl("breakglass"), provider);
  const vaultProgram = new Program<TestVault>(idl("test_vault"), provider);
  for (const p of [bg.programId, vaultProgram.programId]) {
    if (!(await connection.getAccountInfo(p))?.executable) {
      throw new Error(
        `program ${p.toBase58()} is not deployed at ${url}: run 'anchor deploy'`,
      );
    }
  }

  const pda = (seeds: Buffer[], program = bg.programId) =>
    PublicKey.findProgramAddressSync(seeds, program)[0];
  const config = pda([
    Buffer.from("config"),
    vaultProgram.programId.toBuffer(),
  ]);
  const pauseState = pda([Buffer.from("pause"), config.toBuffer()]);
  const eventAuthority = pda([Buffer.from("__event_authority")]);
  const gateSigner = pda(
    [Buffer.from("breakglass-gate")],
    vaultProgram.programId,
  );

  // Register test-vault with Breakglass (once per validator).
  const existing = await bg.account.protocolConfig.fetchNullable(config);
  if (!existing) {
    await bg.methods
      .initializeConfig({
        guardians: [],
        unpausableMask: new BN(1).shln(REPAY),
        timelockSecs: null,
      })
      .accountsPartial({
        payer: payer.publicKey,
        admin: payer.publicKey,
        upgradeAuthority: payer.publicKey,
        protectedProgram: vaultProgram.programId,
        protectedProgramData: pda(
          [vaultProgram.programId.toBuffer()],
          BPF_LOADER_UPGRADEABLE,
        ),
      })
      .rpc();
    console.log(`registered test-vault, config ${config.toBase58()}`);
  } else if (!existing.admin.equals(payer.publicKey)) {
    throw new Error(
      `config admin is ${existing.admin.toBase58()}, not this wallet`,
    );
  }

  /** A fresh mint, vault and limiter, and a user who deposited `deposit` base units. */
  async function newVault(
    limiter: { cap: BN; threshold: BN; holdSecs: BN | null },
    deposit: BN,
  ) {
    const user = Keypair.generate();
    await connection.confirmTransaction(
      await connection.requestAirdrop(user.publicKey, LAMPORTS_PER_SOL),
      "confirmed",
    );
    const mint = await createMint(connection, payer, payer.publicKey, null, 6);
    const vault = pda(
      [Buffer.from("vault"), mint.toBuffer()],
      vaultProgram.programId,
    );
    const vaultToken = pda(
      [Buffer.from("vault_token"), vault.toBuffer()],
      vaultProgram.programId,
    );
    const flowLimiter = pda([
      Buffer.from("flow"),
      config.toBuffer(),
      mint.toBuffer(),
    ]);
    await vaultProgram.methods
      .initializeVault()
      .accountsPartial({ payer: payer.publicKey, mint })
      .rpc();
    await bg.methods
      .initFlowLimiter({
        scope: WITHDRAW,
        windowSecs: null,
        capAbsolute: limiter.cap,
        capBpsOfVault: 0,
        largeThreshold: limiter.threshold,
        largeThresholdBps: 0,
        holdSecs: limiter.holdSecs,
        autoTripSecs: null,
        instantAllowance: null,
        screenSecs: null,
      })
      .accountsPartial({
        admin: payer.publicKey,
        config,
        mint,
        vault: vaultToken,
        flowLimiter,
      })
      .rpc();
    const userToken = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        user.publicKey,
      )
    ).address;
    await mintTo(connection, payer, mint, userToken, payer, deposit.toNumber());
    await vaultProgram.methods
      .deposit(deposit)
      .accountsPartial({
        user: user.publicKey,
        mint,
        userToken,
        bgConfig: config,
        bgPauseState: pauseState,
      })
      .signers([user])
      .rpc();

    let n = new BN(Date.now()).muln(1000);
    const holdFor = (nonce: BN) =>
      pda([
        Buffer.from("hold"),
        config.toBuffer(),
        user.publicKey.toBuffer(),
        nonce.toArrayLike(Buffer, "le", 8),
      ]);
    const common = {
      user: user.publicKey,
      mint,
      vault,
      vaultToken,
      userToken,
      bgConfig: config,
      bgPauseState: pauseState,
      bgFlowLimiter: flowLimiter,
      bgEventAuthority: eventAuthority,
      gateSigner,
    };
    /** Withdraw `amount`; returns the hold PDA it would use if held. */
    async function withdraw(amount: BN) {
      n = n.addn(1);
      const hold = holdFor(n);
      const sig = await vaultProgram.methods
        .withdraw(amount, n)
        .accountsPartial({ ...common, bgHold: hold })
        .signers([user])
        .rpc();
      return { sig, hold };
    }
    async function claim(hold: PublicKey) {
      return vaultProgram.methods
        .claimHeld()
        .accountsPartial({ ...common, bgHold: hold })
        .signers([user])
        .rpc();
    }
    return { user, mint, userToken, flowLimiter, withdraw, claim };
  }

  /** Lift any running pause on WITHDRAW (admin) so the demo starts clean. */
  async function reopenWithdraw() {
    const s = await bg.account.pauseState.fetch(pauseState);
    const now = Math.floor(Date.now() / 1000);
    if (
      s.active.some(
        (p) => p.scope === WITHDRAW && p.pausedUntil.toNumber() > now,
      )
    ) {
      await bg.methods
        .unpause(new BN(1).shln(WITHDRAW))
        .accountsPartial({ authority: payer.publicKey, config, pauseState })
        .rpc();
      console.log(
        "(WITHDRAW was paused from an earlier run: unpaused it first)",
      );
    }
  }

  return {
    connection,
    payer,
    bg,
    vaultProgram,
    config,
    pauseState,
    newVault,
    reopenWithdraw,
  };
}

export function run(main: () => Promise<void>) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
