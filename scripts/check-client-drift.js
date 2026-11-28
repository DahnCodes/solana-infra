// Fails if clients/ts/src no longer matches programs/breakglass/src:
// error names and order (codes are 6000 + index), PDA seeds, and the event
// names listed in docs/FRONTEND.md. No build needed: it reads the source.
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
let failed = false;
const fail = (m) => {
  console.error("DRIFT: " + m);
  failed = true;
};

// Errors: names in declaration order.
const rsErrors = [...read("programs/breakglass/src/errors.rs").matchAll(/^\s*(\w+),\s*$/gm)].map((m) => m[1]);
const tsErrors = [...read("clients/ts/src/errors.ts").matchAll(/code: (\d+), name: "(\w+)"/g)].map((m) => [
  Number(m[1]),
  m[2],
]);
if (rsErrors.length !== tsErrors.length) fail(`errors.rs has ${rsErrors.length} errors, errors.ts has ${tsErrors.length}`);
rsErrors.forEach((name, i) => {
  const t = tsErrors[i];
  if (!t || t[1] !== name || t[0] !== 6000 + i) fail(`error #${i}: errors.rs=${name} (${6000 + i}), errors.ts=${t ? `${t[1]} (${t[0]})` : "missing"}`);
});

// Seeds.
const rsSeeds = Object.fromEntries(
  [...read("programs/breakglass/src/constants.rs").matchAll(/pub const (\w+_SEED): &\[u8\] = b"([^"]+)";/g)].map((m) => [m[1], m[2]]),
);
const tsConst = read("clients/ts/src/constants.ts");
for (const [name, seed] of Object.entries(rsSeeds)) {
  if (!tsConst.includes(`"${seed}"`)) fail(`seed ${name}="${seed}" missing from clients/ts/src/constants.ts`);
}

// Events: every #[event] struct must be documented for the frontend.
const rsEvents = [...read("programs/breakglass/src/events.rs").matchAll(/#\[event\]\s*pub struct (\w+)/g)].map((m) => m[1]);
const doc = read("docs/FRONTEND.md");
for (const ev of rsEvents) if (!doc.includes("`" + ev + "`")) fail(`event ${ev} is not documented in docs/FRONTEND.md`);

// Instructions: every pub fn in the #[program] module must be documented.
const lib = read("programs/breakglass/src/lib.rs");
const ixs = [...lib.matchAll(/pub fn (\w+)\s*\(/g)].map((m) => m[1]);
for (const ix of ixs) if (!doc.includes("`" + ix)) fail(`instruction ${ix} is not documented in docs/FRONTEND.md`);

if (failed) process.exit(1);
console.log(`client in sync: ${rsErrors.length} errors, ${Object.keys(rsSeeds).length} seeds, ${rsEvents.length} events, ${ixs.length} instructions`);
