// Shared setup for the demo scripts: provider from ANCHOR_PROVIDER_URL /
// ANCHOR_WALLET (defaults: local validator, ~/.config/solana/id.json), the two
// programs, test-vault registered with Breakglass (the wallet is admin and
// upgrade authority), and a fresh vault + user per run.
//
// Off localnet (ANCHOR_PROVIDER_URL not 127.0.0.1/localhost), new wallets are
// funded by transfer from the wallet instead of airdrops (devnet's faucet is
// rate-limited). Housekeeping messages go to stderr.

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
  TransactionInstruction,
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
  // Two local demo guardians (gitignored under .anchor/), registered with the
  // config, because adding one later takes the 48h timelock. The first is the
  // guardian bot's key; the second plays the rogue guardian in the attack suite.
  const guardian = loadOrCreateKeypair(
    path.join(__dirname, "../.anchor/demo-guardian-keypair.json"),
  );
  const guardian2 = loadOrCreateKeypair(
    path.join(__dirname, "../.anchor/demo-guardian2-keypair.json"),
  );
  const isLocal = /\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

  /** Give `to` SOL: an airdrop on localnet, a transfer from the wallet elsewhere. */
  async function fund(to: PublicKey, lamports = LAMPORTS_PER_SOL) {
    if (isLocal) {
      await connection.confirmTransaction(
        await connection.requestAirdrop(to, lamports),
        "confirmed",
      );
    } else {
      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: to,
            lamports,
          }),
        ),
      );
    }
  }

  const existing = await bg.account.protocolConfig.fetchNullable(config);
  if (!existing) {
    await bg.methods
      .initializeConfig({
        guardians: [guardian.publicKey, guardian2.publicKey],
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
    console.error(`registered test-vault, config ${config.toBase58()}`);
  } else if (!existing.admin.equals(payer.publicKey)) {
    throw new Error(
      `config admin is ${existing.admin.toBase58()}, not this wallet`,
    );
  }

  type LimiterOpts = {
    cap: BN;
    threshold: BN;
    holdSecs: BN | null;
    instantAllowance?: BN | null;
    screenSecs?: BN | null;
  };

  /**
   * A fresh mint, vault and limiter. `instantAllowance: 0` turns on
   * screen-all; `invariantsOff` only works on a planted-bug build of test-vault.
   */
  async function createVault(
    limiter: LimiterOpts,
    opts: { invariantsOff?: boolean } = {},
  ): Promise<PublicKey> {
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
      .initializeVault(opts.invariantsOff ?? false)
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
        instantAllowance: limiter.instantAllowance ?? null,
        screenSecs: limiter.screenSecs ?? null,
      })
      .accountsPartial({
        admin: payer.publicKey,
        config,
        mint,
        vault: vaultToken,
        flowLimiter,
      })
      .rpc();
    return mint;
  }

  /** Handles for an existing vault (by its mint): PDAs and `addUser`. */
  function vaultFor(mint: PublicKey) {
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
    let n = new BN(Date.now())
      .muln(1000)
      .addn(Math.floor(Math.random() * 1000));

    /** A funded user who deposits `amount` into this vault. */
    async function addUser(amount: BN) {
      const user = Keypair.generate();
      await fund(
        user.publicKey,
        isLocal ? LAMPORTS_PER_SOL : LAMPORTS_PER_SOL / 20,
      );
      const userToken = (
        await getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          mint,
          user.publicKey,
        )
      ).address;
      await mintTo(
        connection,
        payer,
        mint,
        userToken,
        payer,
        amount.toNumber(),
      );
      await vaultProgram.methods
        .deposit(amount)
        .accountsPartial({
          user: user.publicKey,
          mint,
          userToken,
          bgConfig: config,
          bgPauseState: pauseState,
        })
        .signers([user])
        .rpc();

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
      /** A withdraw instruction (for batching or tampering), and its hold PDA. */
      async function withdrawIx(
        amount: BN,
        overrides: Record<string, PublicKey> = {},
      ) {
        n = n.addn(1);
        const hold = holdFor(n);
        const ix = await vaultProgram.methods
          .withdraw(amount, n)
          .accountsPartial({ ...common, bgHold: hold, ...overrides })
          .instruction();
        return { ix, hold };
      }
      /** Send instructions in one transaction signed by this user. */
      async function send(ixs: TransactionInstruction[]) {
        return provider.sendAndConfirm(new Transaction().add(...ixs), [user]);
      }
      async function claim(hold: PublicKey) {
        return vaultProgram.methods
          .claimHeld()
          .accountsPartial({ ...common, bgHold: hold })
          .signers([user])
          .rpc();
      }
      /** PLANTED BUG: move `amount` out of the vault with no gate at all. */
      async function skim(amount: BN) {
        return vaultProgram.methods
          .skim(amount)
          .accountsPartial({
            caller: user.publicKey,
            mint,
            vault,
            vaultToken,
            to: userToken,
          })
          .signers([user])
          .rpc();
      }
      return { user, userToken, withdraw, withdrawIx, send, claim, skim };
    }

    return { mint, vault, vaultToken, flowLimiter, addUser };
  }

  /**
   * A fresh vault (see `createVault`) and a user who deposited `deposit`
   * base units. `addUser(deposit)` adds more depositors to the same vault.
   */
  async function newVault(
    limiter: LimiterOpts,
    deposit: BN,
    opts: { invariantsOff?: boolean } = {},
  ) {
    const v = vaultFor(await createVault(limiter, opts));
    const first = await v.addUser(deposit);
    return { ...first, ...v };
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
      console.error(
        "(WITHDRAW was paused from an earlier run: unpaused it first)",
      );
    }
  }

  return {
    connection,
    provider,
    payer,
    guardian,
    guardian2,
    fund,
    isLocal,
    guardianRegistered: async () =>
      (await bg.account.protocolConfig.fetch(config)).guardians.some((g) =>
        g.equals(guardian.publicKey),
      ),
    bg,
    vaultProgram,
    config,
    pauseState,
    newVault,
    createVault,
    vaultFor,
    reopenWithdraw,
  };
}

function loadOrCreateKeypair(file: string): Keypair {
  if (fs.existsSync(file)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))),
    );
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), {
    mode: 0o600,
  });
  return kp;
}

export function run(main: () => Promise<void>) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
