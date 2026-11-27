import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { Breakglass } from "../target/types/breakglass";
import { TestVault } from "../target/types/test_vault";

describe("breakglass", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const breakglass = anchor.workspace.Breakglass as Program<Breakglass>;
  const testVault = anchor.workspace.TestVault as Program<TestVault>;

  const guardian = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), testVault.programId.toBuffer()],
    breakglass.programId,
  );
  const [pausePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pause"), configPda.toBuffer()],
    breakglass.programId,
  );

  it("initializes a protocol config", async () => {
    await breakglass.methods
      .initializeConfig({
        guardians: [guardian.publicKey],
        unpausableMask: new anchor.BN(1 << 3), // REPAY can never be paused
        timelockSecs: null,
      })
      .accounts({
        payer: provider.wallet.publicKey,
        admin: provider.wallet.publicKey,
        protectedProgram: testVault.programId,
      })
      .rpc();

    const config = await breakglass.account.protocolConfig.fetch(configPda);
    expect(config.admin.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(config.guardians.map((g) => g.toBase58())).to.deep.equal([
      guardian.publicKey.toBase58(),
    ]);
    expect(config.timelockSecs.toNumber()).to.equal(48 * 3600);

    const pause = await breakglass.account.pauseState.fetch(pausePda);
    expect(pause.active.length).to.equal(0);
  });

  // Phase 1 adds: pause / renew / unpause / cooldown / budget / unauthorized tests (tests/pause.ts).
  // Phase 2 adds: outflow gate tests (tests/outflow.ts).
});
