import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explorerTxUrl } from "./explorer.ts";

describe("explorerTxUrl", () => {
  it("links each cluster's transactions", () => {
    assert.equal(
      explorerTxUrl("5abc", "devnet", "https://api.devnet.solana.com"),
      "https://explorer.solana.com/tx/5abc?cluster=devnet",
    );
    assert.equal(
      explorerTxUrl("5abc", "mainnet-beta", "x"),
      "https://explorer.solana.com/tx/5abc",
    );
    assert.equal(
      explorerTxUrl("5abc", "localnet", "http://127.0.0.1:8899"),
      "https://explorer.solana.com/tx/5abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899",
    );
  });
});
