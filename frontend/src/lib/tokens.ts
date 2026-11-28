import type { TokenInfo } from "@/lib/breakglass/describe";
import type { Address } from "@/lib/breakglass";
import { getMockClient } from "@/lib/breakglass/create-client";
import { env } from "@/lib/env";
import { shortAddress } from "@/lib/format";

/**
 * Name and decimals for a token mint. The demo's USDC (the configured mint
 * or the mock's) is known; any other mint shows its short address, with 6
 * decimals until mint metadata is read from chain in phase 6.
 */
export function tokenInfo(mint: Address): TokenInfo {
  const known = [env.usdcMint, getMockClient()?.testVault.mint];
  if (known.includes(mint)) return { symbol: "USDC", decimals: 6 };
  return { symbol: shortAddress(mint), decimals: 6 };
}
