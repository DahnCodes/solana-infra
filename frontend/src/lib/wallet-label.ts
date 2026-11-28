import type { Address } from "@/lib/breakglass";
import { MOCK_WALLETS } from "@/lib/breakglass/mock/seed";
import { shortAddress } from "@/lib/format";

const demoNames = new Map<string, string>(
  Object.values(MOCK_WALLETS).map((w) => [w.address, w.label]),
);

/** A wallet's name for people: the demo wallets by name, others shortened. */
export function walletLabel(address: Address): string {
  return demoNames.get(address) ?? shortAddress(address);
}
