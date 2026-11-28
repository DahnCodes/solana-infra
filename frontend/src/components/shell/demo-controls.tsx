"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { ChevronDown, FastForward, RotateCcw } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useChainNow, useMockControls } from "@/hooks/use-breakglass";
import { formatDateTime, shortAddress } from "@/lib/format";

const H = 3600;

/**
 * Mock mode only: act as any demo wallet, and move the simulated clock so
 * holds unlock and pauses end during a demo. Hidden in live mode.
 */
export function DemoControls() {
  const controls = useMockControls();
  const now = useChainNow();
  const { publicKey } = useWallet();
  const selectId = useId();
  if (!controls) return null;

  const real = publicKey?.toBase58() ?? null;
  const options = [
    ...controls.wallets.map((w) => ({ value: w.address, label: w.label })),
    ...(real
      ? [{ value: real, label: `Your wallet (${shortAddress(real)})` }]
      : []),
  ];

  return (
    <section
      aria-label="Demo controls"
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-3"
    >
      <h2 className="font-label text-caption font-semibold text-ink-muted uppercase">
        Demo
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={selectId} className="text-body text-ink-secondary">
          Acting as
        </label>
        <div className="relative">
          <select
            id={selectId}
            value={controls.wallet ?? ""}
            onChange={(e) => controls.setWallet(e.target.value || null)}
            className="h-10 w-full appearance-none rounded-control border border-line-strong bg-surface pr-9 pl-3 text-body text-ink"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-secondary"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body text-ink-secondary">
          Clock: {now === null ? "…" : formatDateTime(now)}
        </span>
        <div className="flex flex-wrap gap-1.5">
          <ClockButton onClick={() => controls.advanceClock(H)}>
            <FastForward aria-hidden className="size-3.5" />1 h
          </ClockButton>
          <ClockButton onClick={() => controls.advanceClock(6 * H)}>
            <FastForward aria-hidden className="size-3.5" />6 h
          </ClockButton>
          <ClockButton onClick={controls.reset} label="Reset the demo">
            <RotateCcw aria-hidden className="size-3.5" />
            Reset
          </ClockButton>
        </div>
      </div>
      <label className="flex items-center gap-2 text-body text-ink-secondary">
        <input
          type="checkbox"
          checked={controls.outage}
          onChange={(e) => controls.setOutage(e.target.checked)}
          className="size-4 accent-primary"
        />
        Simulate an RPC outage
      </label>
    </section>
  );
}

function ClockButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex h-8 items-center gap-1 rounded-control border border-line-strong bg-surface px-2 font-label text-caption font-semibold text-ink hover:bg-surface-inset"
    >
      {children}
    </button>
  );
}
