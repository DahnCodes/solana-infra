/**
 * Primitive types shared by the Breakglass data model.
 *
 * The data model mirrors docs/FRONTEND.md and the generated IDL on the
 * backend branch (clients/ts/idl/breakglass.json), with field names exactly
 * as Anchor's TypeScript coder gives them (camelCase). It differs from the
 * raw Anchor objects in four ways, so the UI never touches Anchor types:
 *
 *   Anchor            here
 *   PublicKey         Address (base58 string)
 *   BN (u64)          bigint (amounts, masks, nonces, ids)
 *   BN (i64)          number (unix seconds and durations fit safely)
 *   { queued: {} }    "queued" (Rust enums become string literals)
 *
 * The mock client produces this shape directly; the live client (step 6.1)
 * converts Anchor's objects into it.
 */

/** A Solana public key, base58. */
export type Address = string;

/** A transaction signature, base58. */
export type Signature = string;

/** An unsigned 64-bit integer (u64): token amounts, masks, nonces, ids. */
export type U64 = bigint;

/** Unix time in seconds (i64 on chain). */
export type UnixSeconds = number;

/** A duration in seconds (i64 on chain). */
export type Seconds = number;

/** Basis points: 10,000 = 100% (u16 on chain). */
export type Bps = number;

/** A pause scope, 0 to 63 (u8 on chain). Each protocol names its own. */
export type ScopeId = number;

/** A set of scopes as a bitmask: bit n is scope n (u64 on chain). */
export type ScopeMask = bigint;
