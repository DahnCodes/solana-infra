// Phase 4 "after the timelock" tests. solana-test-validator can't move its
// clock and the timelock is at least 24h, so these run the same compiled
// programs (target/deploy/*.so) in LiteSVM, where the clock can be set.
//
// Independent of the validator: its own programs, config and accounts.
// LiteSVM loads programs as non-upgradeable, so the test-vault ProgramData
// account (which initialize_config reads for the upgrade authority) is set
// up directly.

import * as fs from "fs";
import * as path from "path";
import { BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { fromWorkspace, LiteSVMProvider } from "anchor-litesvm";
import { expect } from "chai";
import { Breakglass } from "../target/types/breakglass";
import { TestVault } from "../target/types/test_vault";
import { breakglassError } from "../clients/ts/src/errors";

const root = path.join(__dirname, "..");
const idl = (name: string) =>
  JSON.parse(
    fs.readFileSync(path.join(root, `target/idl/${name}.json`), "utf8"),
  );
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const HOUR = 3600;
const TIMELOCK = 48 * HOUR;
const WITHDRAW = 1;

describe("timelock (LiteSVM, clock warp)", () => {
  const svm = fromWorkspace(root);
  const admin = Keypair.generate();
  const guardian = Keypair.generate();
  const user = Keypair.generate();
  for (const k of [admin, guardian, user]) {
    svm.airdrop(k.publicKey, BigInt(100 * LAMPORTS_PER_SOL));
  }
  const provider = new LiteSVMProvider(svm, new Wallet(admin));
  const bg = new Program<Breakglass>(idl("breakglass"), provider);
  const tv = new Program<TestVault>(idl("test_vault"), provider);

  const pda = (seeds: Buffer[], program = bg.programId) =>
    PublicKey.findProgramAddressSync(seeds, program)[0];
  const config = pda([Buffer.from("config"), tv.programId.toBuffer()]);
  const pauseState = pda([Buffer.from("pause"), config.toBuffer()]);
  const pendingPda = (id: BN) =>
    pda([
      Buffer.from("cfgchg"),
      config.toBuffer(),
      id.toArrayLike(Buffer, "le", 8),
    ]);

  let mint: PublicKey;
  let vault: PublicKey;
  let vaultToken: PublicKey;
  let limiter: PublicKey;
  let userToken: PublicKey;

  // ---- helpers ----------------------------------------------------------

  /** Every send gets a fresh blockhash, so identical transactions aren't deduped. */
  async function send<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } finally {
      svm.expireBlockhash();
    }
  }

  async function expectError(p: Promise<unknown>, name: string) {
    let err: any;
    try {
      await send(p);
    } catch (e) {
      err = e;
    }
    if (!err) expect.fail(`expected ${name}, but the transaction succeeded`);
    const text = [
      String(err.message),
      ...(err.logs ?? err.transactionLogs ?? []),
    ].join("\n");
    const got =
      err.error?.errorCode?.code ?? /Error Code: (\w+)/.exec(text)?.[1];
    expect(got, text).to.equal(name);
    const num =
      err.error?.errorCode?.number ??
      Number(/Error Number: (\d+)/.exec(text)?.[1]);
    expect(breakglassError(num)?.name).to.equal(name);
  }

  function now(): number {
    return Number(svm.getClock().unixTimestamp);
  }

  function warp(secs: number) {
    const c = svm.getClock();
    c.unixTimestamp = c.unixTimestamp + BigInt(secs);
    c.slot = c.slot + BigInt(Math.max(1, Math.floor(secs * 2.5)));
    svm.setClock(c);
    svm.expireBlockhash();
  }

  async function propose(action: any, signer = admin) {
    const id = (await bg.account.protocolConfig.fetch(config)).nextChangeId;
    const pending = pendingPda(id);
    await send(
      bg.methods
        .proposeConfig(action)
        .accountsPartial({
          payer: signer.publicKey,
          admin: signer.publicKey,
          config,
          pending,
        })
        .signers([signer])
        .rpc(),
    );
    return pending;
  }

  function execute(
    pending: PublicKey,
    extra: { flowLimiter?: PublicKey; hold?: PublicKey } = {},
  ) {
    return bg.methods
      .executeConfig()
      .accountsPartial({
        config,
        pending,
        flowLimiter: extra.flowLimiter ?? null,
        hold: extra.hold ?? null,
      })
      .rpc();
  }

  let nonce = new BN(1);
  function withdraw(amount: number) {
    nonce = nonce.addn(1);
    const hold = pda([
      Buffer.from("hold"),
      config.toBuffer(),
      user.publicKey.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ]);
    const p = tv.methods
      .withdraw(new BN(amount), nonce)
      .accountsPartial({
        user: user.publicKey,
        mint,
        vault,
        vaultToken,
        userToken,
        bgConfig: config,
        bgPauseState: pauseState,
        bgFlowLimiter: limiter,
        bgHold: hold,
        bgEventAuthority: pda([Buffer.from("__event_authority")]),
        gateSigner: pda([Buffer.from("breakglass-gate")], tv.programId),
      })
      .signers([user])
      .rpc();
    return { p, hold };
  }

  function claim(hold: PublicKey) {
    return tv.methods
      .claimHeld()
      .accountsPartial({
        user: user.publicKey,
        mint,
        vault,
        vaultToken,
        userToken,
        bgConfig: config,
        bgPauseState: pauseState,
        bgFlowLimiter: limiter,
        bgHold: hold,
        bgEventAuthority: pda([Buffer.from("__event_authority")]),
        gateSigner: pda([Buffer.from("breakglass-gate")], tv.programId),
      })
      .signers([user])
      .rpc();
  }

  function tokenBalance(account: PublicKey): bigint {
    const data = svm.getAccount(account)!.data;
    return Buffer.from(data).readBigUInt64LE(64);
  }

  // ---- setup ------------------------------------------------------------

  before(async () => {
    // Start from a realistic clock.
    const c = svm.getClock();
    c.unixTimestamp = BigInt(1_800_000_000);
    svm.setClock(c);

    // test-vault's ProgramData, with `admin` as upgrade authority:
    // UpgradeableLoaderState::ProgramData { slot: u64, upgrade_authority: Option<Pubkey> }.
    const programData = Buffer.alloc(4 + 8 + 1 + 32);
    programData.writeUInt32LE(3, 0);
    programData.writeUInt8(1, 12);
    admin.publicKey.toBuffer().copy(programData, 13);
    svm.setAccount(pda([tv.programId.toBuffer()], BPF_LOADER_UPGRADEABLE), {
      lamports: LAMPORTS_PER_SOL,
      data: programData,
      owner: BPF_LOADER_UPGRADEABLE,
      executable: false,
    });

    await send(
      bg.methods
        .initializeConfig({
          guardians: [guardian.publicKey],
          unpausableMask: new BN(8),
          timelockSecs: null,
        })
        .accountsPartial({
          payer: admin.publicKey,
          admin: admin.publicKey,
          upgradeAuthority: admin.publicKey,
          protectedProgram: tv.programId,
          protectedProgramData: pda(
            [tv.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE,
          ),
        })
        .rpc(),
    );

    // Mint, vault, limiter (cap 1000, threshold 400, 10 min holds), user deposit.
    const mintKp = Keypair.generate();
    mint = mintKp.publicKey;
    await send(
      provider.sendAndConfirm!(
        new Transaction().add(
          SystemProgram.createAccount({
            fromPubkey: admin.publicKey,
            newAccountPubkey: mint,
            lamports: Number(
              svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)),
            ),
            space: MINT_SIZE,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(mint, 6, admin.publicKey, null),
        ),
        [mintKp],
      ),
    );
    vault = pda([Buffer.from("vault"), mint.toBuffer()], tv.programId);
    vaultToken = pda(
      [Buffer.from("vault_token"), vault.toBuffer()],
      tv.programId,
    );
    limiter = pda([Buffer.from("flow"), config.toBuffer(), mint.toBuffer()]);
    await send(
      tv.methods
        .initializeVault(false)
        .accountsPartial({ payer: admin.publicKey, mint })
        .rpc(),
    );
    await send(
      bg.methods
        .initFlowLimiter({
          scope: WITHDRAW,
          windowSecs: null,
          capAbsolute: new BN(1_000),
          capBpsOfVault: 0,
          largeThreshold: new BN(400),
          largeThresholdBps: 0,
          holdSecs: new BN(600),
          autoTripSecs: null,
          instantAllowance: null,
          screenSecs: null,
        })
        .accountsPartial({
          admin: admin.publicKey,
          config,
          mint,
          vault: vaultToken,
          flowLimiter: limiter,
        })
        .rpc(),
    );
    userToken = getAssociatedTokenAddressSync(mint, user.publicKey);
    await send(
      provider.sendAndConfirm!(
        new Transaction().add(
          createAssociatedTokenAccountInstruction(
            admin.publicKey,
            userToken,
            user.publicKey,
            mint,
          ),
          createMintToInstruction(mint, userToken, admin.publicKey, 10_000),
        ),
      ),
    );
    await send(
      tv.methods
        .deposit(new BN(5_000))
        .accountsPartial({
          user: user.publicKey,
          mint,
          userToken,
          bgConfig: config,
          bgPauseState: pauseState,
        })
        .signers([user])
        .rpc(),
    );
  });

  // ---- tests ------------------------------------------------------------

  it("raising the cap: early execute fails with TimelockActive, after the timelock it applies", async () => {
    const cur = await bg.account.flowLimiter.fetch(limiter);
    const pending = await propose({
      raiseLimits: {
        mint,
        params: {
          windowSecs: cur.windowSecs,
          capAbsolute: new BN(5_000),
          capBpsOfVault: cur.capBpsOfVault,
          largeThreshold: cur.largeThreshold,
          largeThresholdBps: cur.largeThresholdBps,
          holdSecs: cur.holdSecs,
          autoTripSecs: cur.autoTripSecs,
          instantAllowance: cur.instantAllowance,
          screenSecs: cur.screenSecs,
        },
      },
    });
    const p = await bg.account.pendingConfig.fetch(pending);
    expect(p.executableAt.toNumber()).to.equal(now() + TIMELOCK);

    await expectError(
      execute(pending, { flowLimiter: limiter }),
      "TimelockActive",
    );
    warp(TIMELOCK - 1);
    await expectError(
      execute(pending, { flowLimiter: limiter }),
      "TimelockActive",
    );
    warp(1);

    // The limiter account is required, and it must be the one for the mint.
    await expectError(execute(pending), "WrongChangeAccounts");
    await send(execute(pending, { flowLimiter: limiter }));
    expect(
      (await bg.account.flowLimiter.fetch(limiter)).capAbsolute.toNumber(),
    ).to.equal(5_000);
    expect((await bg.account.pendingConfig.fetch(pending)).executed).to.equal(
      true,
    );
    await expectError(
      execute(pending, { flowLimiter: limiter }),
      "ChangeClosed",
    );
  });

  it("a vetoed change still can't execute after the delay (Vetoed)", async () => {
    const pending = await propose({
      addGuardian: { guardian: Keypair.generate().publicKey },
    });
    await send(
      bg.methods
        .vetoConfig()
        .accountsPartial({ guardian: guardian.publicKey, config, pending })
        .signers([guardian])
        .rpc(),
    );
    warp(TIMELOCK + 1);
    await expectError(execute(pending), "Vetoed");
    expect(
      (await bg.account.protocolConfig.fetch(config)).guardians,
    ).to.have.length(1);
  });

  it("a cancelled change can't execute after the delay (ChangeClosed)", async () => {
    const pending = await propose({
      setAdmin: { admin: Keypair.generate().publicKey },
    });
    await send(
      bg.methods
        .cancelConfig()
        .accountsPartial({ admin: admin.publicKey, config, pending })
        .rpc(),
    );
    warp(TIMELOCK + 1);
    await expectError(execute(pending), "ChangeClosed");
  });

  it("a frozen hold is released only through the timelock, then the user can claim it", async () => {
    const before = tokenBalance(userToken);
    const { p, hold } = withdraw(500); // >= threshold 400: held
    await send(p);
    expect(tokenBalance(userToken)).to.equal(before);
    await send(
      bg.methods
        .freezeHeld()
        .accountsPartial({ authority: guardian.publicKey, config, hold })
        .signers([guardian])
        .rpc(),
    );
    warp(601);
    await expectError(claim(hold), "HoldFrozen");

    const pending = await propose({ releaseHeld: { hold } });
    await expectError(execute(pending, { hold }), "TimelockActive");
    warp(TIMELOCK);
    await expectError(execute(pending), "WrongChangeAccounts");
    await send(execute(pending, { hold }));
    expect(
      (await bg.account.pendingWithdrawal.fetch(hold)).status,
    ).to.deep.equal({ released: {} });

    await send(claim(hold));
    expect(tokenBalance(userToken)).to.equal(before + 500n);
    expect(
      (await bg.account.pendingWithdrawal.fetch(hold)).status,
    ).to.deep.equal({ claimed: {} });
  });

  it("adding a guardian takes effect after the timelock", async () => {
    const g2 = Keypair.generate();
    const pending = await propose({ addGuardian: { guardian: g2.publicKey } });
    await expectError(execute(pending), "TimelockActive");
    warp(TIMELOCK);
    await send(execute(pending));
    const guardians = (
      await bg.account.protocolConfig.fetch(config)
    ).guardians.map((g) => g.toBase58());
    expect(guardians).to.include(g2.publicKey.toBase58());
  });

  it("changing the policy (here a 24h timelock) applies after the old timelock, and later proposals use it", async () => {
    const cfg = await bg.account.protocolConfig.fetch(config);
    const pending = await propose({
      changePolicy: {
        policy: cfg.policy,
        unpausableMask: cfg.unpausableMask,
        timelockSecs: new BN(24 * HOUR),
      },
    });
    warp(TIMELOCK);
    await send(execute(pending));
    expect(
      (await bg.account.protocolConfig.fetch(config)).timelockSecs.toNumber(),
    ).to.equal(24 * HOUR);
    const next = await propose({
      addGuardian: { guardian: Keypair.generate().publicKey },
    });
    const p = await bg.account.pendingConfig.fetch(next);
    expect(p.executableAt.toNumber() - p.proposedAt.toNumber()).to.equal(
      24 * HOUR,
    );
  });

  it("a new admin takes over after the timelock; the old admin loses every power", async () => {
    const newAdmin = Keypair.generate();
    svm.airdrop(newAdmin.publicKey, BigInt(10 * LAMPORTS_PER_SOL));
    const pending = await propose({ setAdmin: { admin: newAdmin.publicKey } });
    warp(24 * HOUR);
    await send(execute(pending));
    expect(
      (await bg.account.protocolConfig.fetch(config)).admin.toBase58(),
    ).to.equal(newAdmin.publicKey.toBase58());

    await expectError(
      propose({ setAdmin: { admin: admin.publicKey } }),
      "Unauthorized",
    );
    await propose(
      { addGuardian: { guardian: Keypair.generate().publicKey } },
      newAdmin,
    );
  });
});
