/**
 * Fake but well-formed Solana addresses and signatures for mock mode:
 * base58 strings of the right length, derived from a label so the same
 * label always gives the same address.
 */
import type { Address, Signature } from "../primitives.ts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes: Uint8Array): string {
  let n = BigInt(0);
  for (const b of bytes) n = n * BigInt(256) + BigInt(b);
  let out = "";
  while (n > BigInt(0)) {
    out = ALPHABET[Number(n % BigInt(58))] + out;
    n /= BigInt(58);
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** 32 deterministic bytes from a label (FNV-1a, stretched). */
function hashBytes(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let h = 0x811c9dc5;
  for (let i = 0; i < length; i++) {
    for (const c of `${label}#${i}`) {
      h ^= c.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out[i] = h & 0xff;
  }
  out[0] |= 1; // never a leading zero byte, so the length stays 43 or 44
  return out;
}

/** A stable fake address for `label`. */
export function mockAddress(label: string): Address {
  return base58(hashBytes(label, 32));
}

/** A random fake transaction signature (64 bytes). */
export function mockSignature(): Signature {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  bytes[0] |= 1;
  return base58(bytes);
}

/** A random u64, for hold nonces. */
export function randomU64(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return bytes.reduce((n, b) => n * BigInt(256) + BigInt(b), BigInt(0));
}
