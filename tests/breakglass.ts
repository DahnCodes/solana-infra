import { Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import {
  breakglass,
  configPda,
  ensureConfig,
  expectError,
  fund,
  guardians,
  initConfig,
  onlyEvent,
  pausePda,
  provider,
  testVault,
} from "./helpers";

describe("breakglass", () => {
  it("only the protected program's upgrade authority can register it", async () => {
    const squatter = Keypair.generate();
    await fund(squatter.publicKey);
    await expectError(
      initConfig(testVault.programId, squatter),
      "Unauthorized",
    );
  });

  it("a program without an upgrade authority (non-upgradeable) can't be registered", async () => {
    // The SPL Token program is owned by the non-upgradeable BPF loader: no ProgramData.
    await expectError(initConfig(TOKEN_PROGRAM_ID), "AccountNotInitialized", {
      framework: true,
    });
  });

  it("initializes a protocol config", async () => {
    const sig = await initConfig();

    const config = await breakglass.account.protocolConfig.fetch(configPda);
    expect(config.admin.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58(),
    );
    expect(config.protectedProgram.toBase58()).to.equal(
      testVault.programId.toBase58(),
    );
    expect(config.guardians.map((g) => g.toBase58())).to.deep.equal(
      guardians.map((g) => g.publicKey.toBase58()),
    );
    expect(config.timelockSecs.toNumber()).to.equal(48 * 3600);

    const pause = await breakglass.account.pauseState.fetch(pausePda);
    expect(pause.active.length).to.equal(0);

    const ev = await onlyEvent(sig, "ConfigInitialized");
    expect(ev.config.toBase58()).to.equal(configPda.toBase58());

    await ensureConfig(); // fund guardians for the other test files
  });

  // tests/pause.ts: pause / renew / unpause / cooldown / budget / unauthorized.
  // tests/outflow.ts: outflow gate, holds, limiter, fail-closed account checks.
});
