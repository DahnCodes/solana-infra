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
    <main className="mx-auto w-full max-w-content px-6 py-16">
      <h1 className="text-h3">Breakglass</h1>
      <p className="mt-2 text-title1 text-ink-secondary">
        Setup check. The app is reading this configuration.
      </p>
      <dl className="mt-8 rounded-card bg-surface px-6">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-1 border-b border-line py-4 last:border-b-0 sm:grid-cols-[12rem_1fr]"
          >
            <dt className="font-label text-caption font-semibold text-ink-muted uppercase">
              {label}
            </dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
