import { expect } from "chai";
import {
  breakglass,
  configPda,
  ensureConfig,
  guardians,
  initConfig,
  onlyEvent,
  pausePda,
  provider,
  testVault,
} from "./helpers";

describe("breakglass", () => {
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
  // Phase 2 adds: outflow gate tests (tests/outflow.ts).
});
