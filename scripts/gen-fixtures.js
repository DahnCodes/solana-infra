// Writes tests/fixtures/*.json: accounts preloaded into the `anchor test`
// validator (see [[test.validator.account]] in Anchor.toml).
//
// fake-pause-state.json: a byte-for-byte valid, *unpaused* PauseState for
// test-vault's config, but owned by the SPL Token program instead of
// Breakglass. Passing it instead of the real PauseState must fail (owner check).
//
// Re-run after `anchor keys sync` changes the program IDs:
//   node scripts/gen-fixtures.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PublicKey } = require("@solana/web3.js");

const root = path.join(__dirname, "..");
const toml = fs.readFileSync(path.join(root, "Anchor.toml"), "utf8");
const localnet = toml.split("[programs.localnet]")[1];
const id = (name) => new PublicKey(new RegExp(`${name} = "(\\w+)"`).exec(localnet)[1]);
const breakglass = id("breakglass");
const testVault = id("test_vault");

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), testVault.toBuffer()], breakglass);
const [pause, bump] = PublicKey.findProgramAddressSync([Buffer.from("pause"), config.toBuffer()], breakglass);

const MAX_ACTIVE_PAUSES = 64;
const SCOPE_PAUSE_SIZE = 1 + 8 + 32 + 1 + 1 + 2;
const space = 8 + 1 + 32 + 4 + MAX_ACTIVE_PAUSES * SCOPE_PAUSE_SIZE;
const data = Buffer.alloc(space);
crypto.createHash("sha256").update("account:PauseState").digest().copy(data, 0, 0, 8);
data[8] = bump;
config.toBuffer().copy(data, 9);
data.writeUInt32LE(0, 41); // active: []

// Fixed address so Anchor.toml can name it. Not a PDA of anything.
const FAKE_PAUSE_STATE = "FakePauseState11111111111111111111111111111";
const account = {
  pubkey: FAKE_PAUSE_STATE,
  account: {
    lamports: 1_000_000_000,
    data: [data.toString("base64"), "base64"],
    owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    executable: false,
    rentEpoch: 0,
    space,
  },
};
const out = path.join(root, "tests/fixtures/fake-pause-state.json");
fs.writeFileSync(out, JSON.stringify(account, null, 2) + "\n");
console.log(`wrote ${path.relative(root, out)} (fake of ${pause.toBase58()})`);
