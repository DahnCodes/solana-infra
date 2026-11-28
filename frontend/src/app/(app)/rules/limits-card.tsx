"use client";

import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/button";
import { Dialog } from "@/components/dialog";
import { Input } from "@/components/input";
import { InsetPanel, Panel } from "@/components/panel";
import { useTx } from "@/components/tx/tx-provider";
import type { Role } from "@/hooks/use-breakglass";
import type { AccountRecord, Address, FlowLimiter } from "@/lib/breakglass";
import { limiterParams } from "@/lib/breakglass/accounts";
import { U64_MAX } from "@/lib/breakglass/constants";
import { formatSpan, scopeLabel } from "@/lib/breakglass/describe";
import { BREAKGLASS_MESSAGES } from "@/lib/breakglass/messages";
import { canTighten } from "@/lib/breakglass/permissions";
import { formatUnits } from "@/lib/format";
import { tokenInfo } from "@/lib/tokens";
import {
  draftOf,
  loosenedSettings,
  paramsOf,
  sameParams,
  SETTING_LABELS,
  type LimitsDraft,
  type LimitsErrors,
} from "./limits-model";

/** The nine limiter settings as inputs. */
export function LimitsFields({
  draft,
  errors,
  symbol,
  onChange,
}: {
  draft: LimitsDraft;
  errors: LimitsErrors;
  symbol: string;
  onChange: (patch: Partial<LimitsDraft>) => void;
}) {
  const field = (
    key: keyof LimitsDraft,
    label: string,
    suffix: string,
    hint?: string,
  ) => (
    <Input
      label={label}
      value={draft[key]}
      onChange={(e) => onChange({ [key]: e.target.value })}
      inputMode="decimal"
      suffix={suffix}
      hint={hint}
      error={errors[key]}
    />
  );
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {field("cap", "Cap per window", symbol)}
      {field("capPercent", "Or a share of the vault", "%", "Empty for none.")}
      {field("threshold", "Hold withdrawals from", symbol)}
      {field(
        "thresholdPercent",
        "Or a share of the vault",
        "%",
        "Empty for none.",
      )}
      {field("windowMinutes", "Window", "minutes")}
      {field("holdHours", "Hold for", "hours")}
      {field("autoTripHours", "Auto-trip pause", "hours")}
      {field("screenMinutes", "Screening time", "minutes")}
      {field(
        "instantAllowance",
        "Pay at once up to",
        symbol,
        "Larger withdrawals wait the screening time. Empty for no limit; 0 screens every withdrawal.",
      )}
    </div>
  );
}

/** Each token's current limits, and the admin's "tighten now". */
export function LimitsCard({
  config,
  limiters,
  role,
}: {
  config: Address;
  limiters: AccountRecord<FlowLimiter>[];
  role: Role | null;
}) {
  const [editing, setEditing] = useState<FlowLimiter | null>(null);
  return (
    <Panel
      title="Token limits"
      description="Stricter limits apply at once. Looser ones are proposed below and wait out the timelock."
    >
      {limiters.length === 0 ? (
        <p className="text-body text-ink-secondary">
          No token has a limiter yet. The admin sets one up when registering.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {limiters.map(({ address, account: l }) => {
            const t = tokenInfo(l.mint);
            const money = (v: bigint) =>
              `${formatUnits(v, t.decimals)} ${t.symbol}`;
            const rows: [string, string][] = [
              [
                "Cap",
                `${money(l.capAbsolute)}${l.capBpsOfVault ? ` or ${l.capBpsOfVault / 100}% of the vault` : ""} per ${formatSpan(l.windowSecs)}`,
              ],
              [
                "Holds",
                `From ${money(l.largeThreshold)}${l.largeThresholdBps ? ` or ${l.largeThresholdBps / 100}% of the vault` : ""}, for ${formatSpan(l.holdSecs)}`,
              ],
              ["Auto-trip pause", formatSpan(l.autoTripSecs)],
              [
                "Screening",
                l.instantAllowance === U64_MAX
                  ? "Off"
                  : l.instantAllowance === BigInt(0)
                    ? `Every withdrawal, ${formatSpan(l.screenSecs)}`
                    : `Above ${money(l.instantAllowance)}, ${formatSpan(l.screenSecs)}`,
              ],
            ];
            return (
              <li key={address} className="flex flex-col gap-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-title2 font-medium">
                    {t.symbol}{" "}
                    <span className="font-normal text-ink-secondary">
                      gates {scopeLabel(l.scope).toLowerCase()}
                    </span>
                  </span>
                  {canTighten(role).allowed && (
                    <Button
                      icon={<ArrowDownToLine aria-hidden className="size-4" />}
                      onClick={() => setEditing(l)}
                    >
                      Tighten
                    </Button>
                  )}
                </div>
                <dl className="grid gap-x-4 gap-y-1 text-body sm:grid-cols-[auto_1fr]">
                  {rows.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-ink-secondary">{k}</dt>
                      <dd>{v}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
      {editing && (
        <TightenDialog
          key={editing.mint}
          config={config}
          limiter={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function TightenDialog({
  config,
  limiter,
  onClose,
}: {
  config: Address;
  limiter: FlowLimiter;
  onClose: () => void;
}) {
  const t = tokenInfo(limiter.mint);
  const [draft, setDraft] = useState(() => draftOf(limiter, t.decimals));
  const parsed = paramsOf(draft, t.decimals);
  const current = limiterParams(limiter);
  const params = "params" in parsed ? parsed.params : null;
  const loosened = params ? loosenedSettings(current, params) : [];
  const unchanged = params ? sameParams(current, params) : false;
  const ok = params !== null && loosened.length === 0 && !unchanged;

  const tx = useTx();
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!ok || !params) return;
    const next = params;
    onClose();
    await tx.send({
      title: `Tighten the ${t.symbol} limits?`,
      summary:
        "The new limits apply as soon as this confirms, with no timelock. Loosening them again later means a proposal and the full timelock.",
      details: [{ label: "Token", value: t.symbol }],
      confirmLabel: "Tighten limits",
      onStart: () => setSending(true),
      run: (c) => c.tightenLimits({ config, mint: limiter.mint, params: next }),
      done: `${t.symbol} limits tightened`,
    });
    setSending(false);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Tighten the ${t.symbol} limits`}
      description="Every setting must stay the same or get stricter: a lower cap or threshold, a longer window, hold or screening."
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={sending}
            disabled={!ok}
            onClick={send}
          >
            Tighten now
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <LimitsFields
          draft={draft}
          errors={"errors" in parsed ? parsed.errors : {}}
          symbol={t.symbol}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
        />
        {loosened.length > 0 && (
          <InsetPanel className="text-body">
            {BREAKGLASS_MESSAGES.NotTightening} Looser:{" "}
            {loosened.map((k) => SETTING_LABELS[k]).join(", ")}.
          </InsetPanel>
        )}
        {unchanged && (
          <p className="text-body text-ink-secondary">
            Change at least one setting.
          </p>
        )}
      </div>
    </Dialog>
  );
}
