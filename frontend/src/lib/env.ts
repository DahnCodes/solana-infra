/**
 * App configuration, read from NEXT_PUBLIC_ environment variables.
 *
 * Next.js only inlines a variable when it is written out in full as
 * `process.env.NEXT_PUBLIC_NAME`, so each one is read by name below.
 * An empty or missing value falls back to the default. A value that is set
 * but invalid throws at startup, so a typo can't silently point the app at
 * the wrong program or cluster.
 */

export const DATA_MODES = ["mock", "live"] as const;
export type DataMode = (typeof DATA_MODES)[number];

export const CLUSTERS = ["localnet", "devnet", "mainnet-beta"] as const;
export type Cluster = (typeof CLUSTERS)[number];

const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function oneOf<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = present(value);
  if (v === undefined) return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")}. Got "${v}".`);
}

function pubkey(name: string, value: string | undefined): string | null;
function pubkey(
  name: string,
  value: string | undefined,
  fallback: string,
): string;
function pubkey(
  name: string,
  value: string | undefined,
  fallback: string | null = null,
): string | null {
  const v = present(value);
  if (v === undefined) return fallback;
  if (BASE58_PUBKEY.test(v)) return v;
  throw new Error(`${name} must be a base58 Solana address. Got "${v}".`);
}

function httpUrl(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const v = present(value);
  if (v === undefined) return fallback;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" || u.protocol === "https:")
      return v.replace(/\/$/, "");
  } catch {
    // fall through to the error below
  }
  throw new Error(`${name} must be an http(s) URL. Got "${v}".`);
}

export const env = {
  dataMode: oneOf(
    "NEXT_PUBLIC_DATA_MODE",
    process.env.NEXT_PUBLIC_DATA_MODE,
    DATA_MODES,
    "mock",
  ),
  cluster: oneOf(
    "NEXT_PUBLIC_SOLANA_CLUSTER",
    process.env.NEXT_PUBLIC_SOLANA_CLUSTER,
    CLUSTERS,
    "devnet",
  ),
  rpcUrl: httpUrl(
    "NEXT_PUBLIC_RPC_URL",
    process.env.NEXT_PUBLIC_RPC_URL,
    "https://api.devnet.solana.com",
  ),
  breakglassProgramId: pubkey(
    "NEXT_PUBLIC_BREAKGLASS_PROGRAM_ID",
    process.env.NEXT_PUBLIC_BREAKGLASS_PROGRAM_ID,
    "AiMhNgDgXLQ68FhZrYczUiGxDxDeDxNFDTurqNFPP5kB",
  ),
  protectedProgramId: pubkey(
    "NEXT_PUBLIC_PROTECTED_PROGRAM_ID",
    process.env.NEXT_PUBLIC_PROTECTED_PROGRAM_ID,
    "2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn",
  ),
  usdcMint: pubkey("NEXT_PUBLIC_USDC_MINT", process.env.NEXT_PUBLIC_USDC_MINT),
  monitorApiUrl: httpUrl(
    "NEXT_PUBLIC_MONITOR_API_URL",
    process.env.NEXT_PUBLIC_MONITOR_API_URL,
    "http://127.0.0.1:8080",
  ),
} as const;

export type Env = typeof env;
