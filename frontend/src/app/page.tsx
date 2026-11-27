import { env } from "@/lib/env";

// Temporary setup page: proves the app reads its config (checklist step 0.3).
// Replaced by the landing page in step 4.2.
const rows: [string, string][] = [
  ["Data mode", env.dataMode],
  ["Cluster", env.cluster],
  ["RPC URL", env.rpcUrl],
  ["Breakglass program", env.breakglassProgramId],
  ["Protected program", env.protectedProgramId],
  ["USDC mint", env.usdcMint ?? "Not set yet (checkpoint B)"],
  ["Monitor API", env.monitorApiUrl],
];

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Breakglass</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Setup check. The app is reading this configuration.
      </p>
      <dl className="mt-8 divide-y divide-zinc-200 border-y border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
            <dt className="text-zinc-600 dark:text-zinc-400">{label}</dt>
            <dd className="font-medium break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
