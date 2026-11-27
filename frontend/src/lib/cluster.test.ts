import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENESIS_HASHES, networkProblem } from "./cluster.ts";

const DEVNET = GENESIS_HASHES.devnet;
const MAINNET = GENESIS_HASHES["mainnet-beta"];
const LOCAL = "9Xk1localvalidatorgenesishash11111111111111";

describe("networkProblem", () => {
  it("is fine on devnet with a devnet RPC, or before the RPC answers", () => {
    assert.equal(networkProblem("devnet", DEVNET), null);
    assert.equal(networkProblem("devnet", null), null);
    assert.equal(networkProblem("localnet", LOCAL), null);
  });

  it("always warns on mainnet", () => {
    assert.deepEqual(networkProblem("mainnet-beta", null), { kind: "mainnet" });
    assert.deepEqual(networkProblem("mainnet-beta", MAINNET), {
      kind: "mainnet",
    });
    // Configured for devnet but the RPC is really mainnet.
    assert.deepEqual(networkProblem("devnet", MAINNET), { kind: "mainnet" });
  });

  it("warns when the RPC answers for another cluster", () => {
    assert.deepEqual(networkProblem("devnet", LOCAL), {
      kind: "mismatch",
      expected: "devnet",
      actual: "other",
    });
    assert.deepEqual(networkProblem("localnet", DEVNET), {
      kind: "mismatch",
      expected: "localnet",
      actual: "devnet",
    });
  });
});
