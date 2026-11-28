"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useSyncExternalStore } from "react";
import type {
  Address,
  HoldStatus,
  IncidentStatus,
  ProtocolConfig,
} from "@/lib/breakglass";
import { getMockClient } from "@/lib/breakglass/create-client";
import { MOCK_WALLETS } from "@/lib/breakglass/mock/seed";
import { env } from "@/lib/env";
import { useClientQuery } from "./use-client-query";
import { useHydrated } from "./use-hydrated";
import { useNow } from "./use-now";

/*
 * One hook per read in BreakglassClient. Each returns { data, error,
 * loading } and refreshes by itself after every write, wallet switch, mock
 * clock jump or live update. Pass null for an address that isn't known yet
 * and the hook waits.
 */

// Protocol -----------------------------------------------------------------------

/** The configured protocol's config (NEXT_PUBLIC_PROTECTED_PROGRAM_ID). */
export function useProtocol(
  protectedProgram: Address = env.protectedProgramId,
) {
  return useClientQuery(`config:${protectedProgram}`, (c) =>
    c.getConfig(protectedProgram),
  );
}

export function useProtocols() {
  return useClientQuery("configs", (c) => c.listConfigs());
}

export function usePauseState(config: Address | null) {
  return useClientQuery(config && `pause:${config}`, (c) =>
    c.getPauseState(config!),
  );
}

export function useFlowLimiters(config: Address | null) {
  return useClientQuery(config && `limiters:${config}`, (c) =>
    c.listFlowLimiters(config!),
  );
}

export function useTokenBalance(tokenAccount: Address | null) {
  return useClientQuery(tokenAccount && `balance:${tokenAccount}`, (c) =>
    c.getTokenBalance(tokenAccount!),
  );
}

export function useHolds(
  config: Address | null,
  filter: { owner?: Address | null; status?: HoldStatus } = {},
) {
  const owner = filter.owner ?? undefined;
  // An owner filter of null means "this wallet", which isn't known yet.
  const waiting = filter.owner === null;
  return useClientQuery(
    config && !waiting
      ? `holds:${config}:${owner ?? "*"}:${filter.status ?? "*"}`
      : null,
    (c) => c.listHolds(config!, { owner, status: filter.status }),
  );
}

export function usePendingChanges(config: Address | null) {
  return useClientQuery(config && `changes:${config}`, (c) =>
    c.listPendingChanges(config!),
  );
}

export function useGuardianLedger(
  config: Address | null,
  guardian: Address | null,
) {
  return useClientQuery(
    config && guardian ? `ledger:${config}:${guardian}` : null,
    (c) => c.getGuardianLedger(config!, guardian!),
  );
}

export function usePosition(vault: Address | null, owner: Address | null) {
  return useClientQuery(
    vault && owner ? `position:${vault}:${owner}` : null,
    (c) => c.getPosition(vault!, owner!),
  );
}

/** The newest events for a protocol (the activity feed). */
export function useEvents(config: Address | null, limit = 50) {
  return useClientQuery(config && `events:${config}:${limit}`, (c) =>
    c.listEvents(config!, { limit }),
  );
}

// Monitor --------------------------------------------------------------------------

export function useIncidents(status?: IncidentStatus) {
  return useClientQuery(`incidents:${status ?? "*"}`, (c) =>
    c.listIncidents(status),
  );
}

export function useIncident(id: string | null) {
  return useClientQuery(id && `incident:${id}`, (c) => c.getIncident(id!));
}

// Time -------------------------------------------------------------------------------

/**
 * Cluster time, ticking every second: the real clock plus the cluster's
 * offset (the simulated clock in mock mode). null before hydration.
 * Use this, not the browser clock, for anything the program decides
 * (pause expiry, releaseAt, executableAt).
 */
export function useChainNow(): number | null {
  const real = useNow();
  const { data: offset } = useClientQuery(
    "clock-offset",
    async (c) => (await c.getClock()) - Math.floor(Date.now() / 1000),
  );
  return real === null || offset === undefined ? null : real + offset;
}

// Wallet and role ------------------------------------------------------------------

const subscribeToMock = (onChange: () => void) =>
  getMockClient()?.subscribe(onChange) ?? (() => {});

/**
 * The connected wallet. In live mode, the wallet connected through the
 * adapter. In mock mode, the wallet the mock acts as: the role switcher's
 * pick, or the real wallet while one is connected (see SolanaProvider).
 */
export function useConnectedWallet(): Address | null {
  const { publicKey } = useWallet();
  const mockWallet = useSyncExternalStore(
    subscribeToMock,
    () => getMockClient()?.connectedWallet ?? null,
    () => null,
  );
  return env.dataMode === "mock" ? mockWallet : (publicKey?.toBase58() ?? null);
}

export type Role = "admin" | "guardian" | "user";

/** What the wallet is to this protocol. A wallet that is both acts as admin. */
export function roleOf(
  config: ProtocolConfig | undefined,
  wallet: Address | null,
): Role | null {
  if (!config || !wallet) return null;
  if (wallet === config.admin) return "admin";
  if (config.guardians.includes(wallet)) return "guardian";
  return "user";
}

/**
 * The demo's protected protocol (the test vault): its program, vault
 * account, mint and token account. In mock mode, the mock's; in live mode,
 * null until checkpoint B gives the devnet addresses.
 */
export function useTestVault() {
  const hydrated = useHydrated();
  return hydrated ? (getMockClient()?.testVault ?? null) : null;
}

/** Mock-only demo controls, or null in live mode (and before hydration). */
export function useMockControls() {
  const wallet = useConnectedWallet();
  const hydrated = useHydrated();
  const mock = hydrated ? getMockClient() : null;
  if (!mock) return null;
  return {
    wallet,
    wallets: Object.values(MOCK_WALLETS),
    setWallet: (address: Address | null) => mock.setWallet(address),
    advanceClock: (seconds: number) => mock.advanceClock(seconds),
    reset: () => mock.reset(),
    requestTestTokens: (amount: bigint) => mock.requestTestTokens(amount),
    createDemoProgram: () => mock.createDemoProgram(),
    testVault: mock.testVault,
  };
}
