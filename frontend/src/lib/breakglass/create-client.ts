import { env } from "@/lib/env";
import type { BreakglassClient } from "./client.ts";
import { MockClient, mockTestVault } from "./mock/client.ts";

let client: BreakglassClient | null = null;

/**
 * The app's one BreakglassClient, picked by NEXT_PUBLIC_DATA_MODE. Mock mode
 * runs the in-memory gate; live mode (devnet) arrives in phase 6.
 */
export function getBreakglassClient(): BreakglassClient {
  if (client) return client;
  if (env.dataMode === "live") {
    throw new Error(
      "Live data mode isn't built yet (checklist phase 6). Set NEXT_PUBLIC_DATA_MODE=mock.",
    );
  }
  client = new MockClient({
    breakglassProgram: env.breakglassProgramId,
    testVault: mockTestVault(env.protectedProgramId, env.usdcMint),
  });
  return client;
}

/** The mock client, for mock-only controls (clock, wallet switcher), or null. */
export function getMockClient(): MockClient | null {
  if (env.dataMode !== "mock") return null;
  const current = getBreakglassClient();
  return current instanceof MockClient ? current : null;
}
