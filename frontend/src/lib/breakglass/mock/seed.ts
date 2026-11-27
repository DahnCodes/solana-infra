/**
 * The demo state mock mode starts in. It is built by replaying real actions
 * at past times through the engine, so every figure, event and incident is
 * consistent with the rules. At "now" the test vault has:
 *
 * - 2,040,500 USDC deposited; 40,500 USDC has left in the last hour
 *   (cap 150,000 per hour, large withdrawals from 100,000).
 * - A guardian pause on Borrows, ending in 4 hours.
 * - Three holds: 120,000 claimable now, 250,000 releasing in 3 hours, and
 *   180,000 frozen by the guardian.
 * - A proposal to raise the cap to 250,000, executable in 28 hours.
 */
import { scopeMask, TEST_VAULT_SCOPES } from "../constants.ts";
import type { Address, UnixSeconds } from "../primitives.ts";
import { mockAddress } from "./address.ts";
import {
  configAddress,
  type MockEngine,
  walletTokenAccount,
} from "./engine.ts";

/** USDC has 6 decimals. */
export const usdc = (whole: number) => BigInt(Math.round(whole * 1e6));

export type MockWallet = {
  address: Address;
  label: string;
  /** What this wallet is in the demo. */
  role: "admin" | "guardian" | "user";
};

/** The wallets mock mode can act as (the role switcher lists them). */
export const MOCK_WALLETS = {
  admin: {
    address: mockAddress("wallet:admin"),
    label: "Protocol admin",
    role: "admin",
  },
  guardian: {
    address: mockAddress("wallet:guardian"),
    label: "Guardian",
    role: "guardian",
  },
  user: {
    address: mockAddress("wallet:user"),
    label: "Ada (user)",
    role: "user",
  },
  user2: {
    address: mockAddress("wallet:user2"),
    label: "Ben (user)",
    role: "user",
  },
} as const satisfies Record<string, MockWallet>;

const H = 3600;
const M = 60;

/** Replays the demo history so that it ends at `now`. */
export function seedDemo(engine: MockEngine, now: UnixSeconds): void {
  const { admin, guardian, user, user2 } = MOCK_WALLETS;
  const tv = engine.testVault;
  const config = configAddress(tv.program);
  const at = (signer: MockWallet, secondsAgo: number) => ({
    signer: signer.address,
    now: now - secondsAgo,
  });

  // Day before: register the test vault and set up its USDC limiter.
  engine.initializeConfig(at(admin, 26 * H), {
    protectedProgram: tv.program,
    admin: admin.address,
    guardians: [guardian.address],
    unpausableMask: scopeMask(TEST_VAULT_SCOPES.repay),
    timelockSecs: null,
  });
  engine.initFlowLimiter(at(admin, 26 * H), {
    config,
    mint: tv.mint,
    vault: tv.tokenAccount,
    scope: TEST_VAULT_SCOPES.withdraw,
    windowSecs: H,
    capAbsolute: usdc(150_000),
    capBpsOfVault: 1500,
    largeThreshold: usdc(100_000),
    largeThresholdBps: 500,
    holdSecs: 6 * H,
    autoTripSecs: H,
    instantAllowance: null,
    screenSecs: null,
  });

  // Wallets and deposits. Other depositors' funds sit in the vault directly.
  engine.balances.set(walletTokenAccount(user.address, tv.mint), usdc(625_000));
  engine.balances.set(
    walletTokenAccount(user2.address, tv.mint),
    usdc(310_000),
  );
  engine.balances.set(tv.tokenAccount, usdc(1_140_500));
  engine.deposit(at(user, 25 * H), tv.vault, usdc(600_000));
  engine.deposit(at(user2, 25 * H), tv.vault, usdc(300_000));

  // The admin proposes a higher cap; it waits out the 48h timelock.
  engine.proposeConfig(at(admin, 20 * H), config, {
    kind: "raiseLimits",
    mint: tv.mint,
    capAbsolute: usdc(250_000),
    capBpsOfVault: 1500,
    largeThreshold: usdc(100_000),
    largeThresholdBps: 500,
  });

  // Holds: one now claimable, one frozen by the guardian, one still waiting.
  engine.withdraw(at(user, 7 * H), tv.vault, usdc(120_000));
  const frozen = engine.withdraw(at(user2, 5 * H), tv.vault, usdc(180_000));
  if (frozen.decision === "hold") {
    engine.freezeHeld(at(guardian, 4 * H + 50 * M), config, frozen.hold);
  }
  engine.withdraw(at(user, 3 * H), tv.vault, usdc(250_000));

  // The guardian pauses Borrows for six hours.
  engine.pause(
    at(guardian, 2 * H),
    config,
    scopeMask(TEST_VAULT_SCOPES.borrow),
    6 * H,
    7,
  );

  // Normal withdrawals inside the current window.
  engine.withdraw(at(user, 50 * M), tv.vault, usdc(12_000));
  engine.withdraw(at(user, 35 * M), tv.vault, usdc(8_500));
  engine.withdraw(at(user, 10 * M), tv.vault, usdc(20_000));

  // The guardian has seen the first large-withdrawal alert.
  // Incidents are newest first, so the first alert is the last match.
  const first = engine.incidents.findLast(
    (i) => i.detector === "large-withdrawal",
  );
  if (first) {
    first.status = "acked";
    first.acked_by = "guardian";
    first.acked_at = new Date((now - 6 * H) * 1000).toISOString();
  }
}
