"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Amount } from "@/components/amount";
import { Badge, type Status } from "@/components/badge";
import { Countdown } from "@/components/countdown";
import { PageHeader } from "@/components/page-header";
import { ErrorNote, QueryStatus, Skeleton } from "@/components/query-state";
import { InsetPanel, Panel } from "@/components/panel";
import { Select } from "@/components/select";
import { BucketBars, WindowMeter } from "@/components/window-meter";
import {
  useChainClock,
  useFlowLimiters,
  useGuardianLedger,
  useHolds,
  useIncidents,
  usePauseState,
  usePendingChanges,
  useProtocol,
  useProtocols,
  useTokenBalance,
} from "@/hooks/use-breakglass";
import type {
  AccountRecord,
  Address,
  FlowLimiter,
  PausePolicy,
  PauseState,
  ProtocolConfig,
  ScopePause,
  Severity,
} from "@/lib/breakglass";
import { scopesInMask } from "@/lib/breakglass/constants";
import {
  describeAction,
  formatSpan,
  pauseKindLabel,
  scopeLabel,
} from "@/lib/breakglass/describe";
import {
  bucketsOldestFirst,
  bucketWidth,
  effectiveCap,
  effectiveThreshold,
  windowUsage,
} from "@/lib/breakglass/rules/limiter";
import {
  budgetLeft,
  cooldownEnds,
  runningPauses,
} from "@/lib/breakglass/rules/pauses";
import { formatDateTime, shortAddress } from "@/lib/format";
import { tokenInfo } from "@/lib/tokens";
import type { QueryResult } from "@/hooks/use-client-query";
import { walletLabel } from "@/lib/wallet-label";

/** The protocol dashboard: everything about the gate on one screen. */
export function Overview() {
  const fallback = useProtocol();
  const protocols = useProtocols();
  const [picked, setPicked] = useState<Address | null>(null);
  const clock = useChainClock();
  const now = clock.now;

  const list = protocols.data ?? [];
  const current =
    list.find((p) => p.address === picked) ?? fallback.data ?? list[0] ?? null;

  const failed =
    (fallback.data === undefined && fallback.error) ||
    (protocols.data === undefined && protocols.error) ||
    clock.error;
  if (failed) {
    return (
      <>
        <PageHeader title="Overview" />
        <ErrorNote
          what="the gate"
          error={failed}
          onRetry={() => {
            fallback.retry();
            protocols.retry();
            clock.retry();
          }}
        />
      </>
    );
  }
  if (fallback.loading || protocols.loading || now === null) {
    return (
      <>
        <PageHeader title="Overview" />
        <Panel>
          <Skeleton rows={5} label="the gate" />
        </Panel>
      </>
    );
  }
  if (!current) {
    return (
      <>
        <PageHeader title="Overview" />
        <Panel title="No protocol behind the gate yet">
          <p className="text-body text-ink-secondary">
            Register one to see its pauses, limits and holds here.{" "}
            <Link
              href="/register"
              className="text-ink underline underline-offset-4"
            >
              Register a protocol
            </Link>
          </p>
        </Panel>
      </>
    );
  }

  return (
    <ProtocolOverview
      record={current}
      now={now}
      picker={
        list.length > 1 && (
          <Select
            label="Protocol"
            value={current.address}
            onChange={(e) => setPicked(e.target.value)}
            options={list.map((p) => ({
              value: p.address,
              label: shortAddress(p.account.protectedProgram),
            }))}
            className="min-w-56"
          />
        )
      }
    />
  );
}

function ProtocolOverview({
  record,
  now,
  picker,
}: {
  record: AccountRecord<ProtocolConfig>;
  now: number;
  picker: ReactNode;
}) {
  const config = record.address;
  const cfg = record.account;
  const pauses = usePauseState(config);
  const limiters = useFlowLimiters(config);
  const running = runningPauses(pauses.data?.account.active ?? [], now);
  const gatePaused = (limiters.data ?? []).some((l) =>
    running.some((p) => p.scope === l.account.scope),
  );

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          <span className="flex flex-wrap items-center gap-2">
            Protocol {shortAddress(cfg.protectedProgram)}
            {limiters.data &&
              (gatePaused ? (
                <Badge status="tripped">Withdrawals paused</Badge>
              ) : (
                <Badge status="open">Gate open</Badge>
              ))}
          </span>
        }
        actions={picker}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {limiters.data === undefined && (
            <Panel title="Withdrawal window">
              <QueryStatus
                query={limiters}
                what="the withdrawal limits"
                rows={4}
              />
            </Panel>
          )}
          {limiters.data?.length === 0 && (
            <Panel title="Withdrawal window">
              <p className="text-body text-ink-secondary">
                No token has a limiter yet, so nothing is capped.
              </p>
            </Panel>
          )}
          {limiters.data?.map((l) => (
            <WindowCard
              key={l.address}
              limiter={l.account}
              running={running}
              now={now}
            />
          ))}
        </div>
        <ScopesCard
          config={cfg}
          limiters={limiters.data ?? []}
          pauses={pauses}
          running={running}
          now={now}
        />
        <HoldsCard config={config} now={now} />
        <ChangesCard config={config} now={now} />
        <GuardiansCard config={config} cfg={cfg} now={now} />
        <IncidentsCard program={cfg.protectedProgram} />
      </div>
    </>
  );
}

// Cards ------------------------------------------------------------------------

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 font-label text-body font-semibold text-ink hover:bg-surface-inset"
    >
      {children}
      <ArrowRight aria-hidden className="size-4" />
    </Link>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="font-label text-caption font-semibold text-ink-muted uppercase">
      {children}
    </span>
  );
}

function WindowCard({
  limiter,
  running,
  now,
}: {
  limiter: FlowLimiter;
  running: ScopePause[];
  now: number;
}) {
  const balance = useTokenBalance(limiter.vault);
  const token = tokenInfo(limiter.mint);
  const tripped = running.some(
    (p) => p.scope === limiter.scope && p.kind === "autoTrip",
  );

  if (balance.data === undefined) {
    return (
      <Panel title={`${token.symbol} withdrawal window`}>
        <QueryStatus query={balance} what="the vault balance" rows={4} />
      </Panel>
    );
  }

  const used = windowUsage(limiter, now);
  const cap = effectiveCap(limiter, balance.data);
  const left = cap > used ? cap - used : BigInt(0);
  const buckets = bucketsOldestFirst(limiter, now);
  const width = bucketWidth(limiter);
  // The oldest bucket with outflow leaves the window at its end.
  const oldestFilled = buckets.findIndex((b) => b > BigInt(0));
  const nextRollOff =
    oldestFilled === -1
      ? null
      : (Math.floor(now / width) -
          (buckets.length - 1) +
          oldestFilled +
          buckets.length) *
        width;

  return (
    <Panel
      title={`${token.symbol} withdrawal window`}
      description={`At most this much can leave every ${formatSpan(limiter.windowSecs)}. Crossing it pauses ${scopeLabel(limiter.scope).toLowerCase()} by itself.`}
      actions={
        tripped ? (
          <Badge status="tripped">Cap hit: paused</Badge>
        ) : (
          <Badge status="open">Within the cap</Badge>
        )
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label>Used in this window</Label>
            <span>
              <Amount value={used} decimals={token.decimals} size="card" />
              <span className="text-body text-ink-secondary">
                {" "}
                of{" "}
                <Amount
                  value={cap}
                  decimals={token.decimals}
                  symbol={token.symbol}
                />
              </span>
            </span>
          </div>
          <div className="flex flex-col gap-1 text-right max-sm:text-left">
            <Label>Can still leave</Label>
            <Amount
              value={left}
              decimals={token.decimals}
              symbol={token.symbol}
            />
          </div>
        </div>
        <WindowMeter
          used={used}
          cap={cap}
          label={`${token.symbol} window used`}
        />
        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-2">
            <Label>Outflow by {formatSpan(width)} slice, oldest first</Label>
            <BucketBars
              buckets={buckets}
              label={`${token.symbol} outflow in each slice of the window`}
            />
            <span className="text-body text-ink-muted">
              {nextRollOff === null
                ? "Nothing has left in this window."
                : `The oldest outflow leaves the window ${formatDateTime(nextRollOff)}.`}
            </span>
          </div>
          <InsetPanel className="grid content-start gap-x-4 gap-y-2 text-body sm:grid-cols-2">
            <span className="text-ink-secondary">In the vault</span>
            <Amount
              value={balance.data}
              decimals={token.decimals}
              symbol={token.symbol}
            />
            <span className="text-ink-secondary">Held from</span>
            <Amount
              value={effectiveThreshold(limiter, balance.data)}
              decimals={token.decimals}
              symbol={token.symbol}
            />
            <span className="text-ink-secondary">Held for</span>
            <span>{formatSpan(limiter.holdSecs)}</span>
            <span className="text-ink-secondary">Screening</span>
            <span>
              {limiter.instantAllowance === BigInt(0)
                ? "Every withdrawal"
                : limiter.instantAllowance < BigInt("18446744073709551615")
                  ? "Above the instant allowance"
                  : "Off"}
            </span>
          </InsetPanel>
        </div>
      </div>
    </Panel>
  );
}

function ScopesCard({
  config,
  limiters,
  pauses,
  running,
  now,
}: {
  config: ProtocolConfig;
  limiters: AccountRecord<FlowLimiter>[];
  pauses: QueryResult<AccountRecord<PauseState> | null>;
  running: ScopePause[];
  now: number;
}) {
  // Without the pause state, "open" would be a guess: show the load state.
  if (pauses.data === undefined) {
    return (
      <Panel title="Scopes" description="What the protocol can do right now.">
        <QueryStatus query={pauses} what="the pause state" rows={4} />
      </Panel>
    );
  }
  const always = scopesInMask(config.unpausableMask);
  const scopes = [
    ...new Set([
      0,
      1,
      2,
      3,
      ...always,
      ...limiters.map((l) => l.account.scope),
      ...running.map((p) => p.scope),
    ]),
  ].sort((a, b) => a - b);

  return (
    <Panel
      title="Scopes"
      description="What the protocol can do right now."
      actions={<CardLink href="/rules">Pauses</CardLink>}
    >
      <ul className="flex flex-col divide-y divide-line">
        {scopes.map((scope) => {
          const entries = running.filter((p) => p.scope === scope);
          const latest = entries.reduce<ScopePause | null>(
            (a, p) => (!a || p.pausedUntil > a.pausedUntil ? p : a),
            null,
          );
          return (
            <li
              key={scope}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <span className="text-title2 font-medium">
                {scopeLabel(scope)}
              </span>
              {always.includes(scope) ? (
                <Badge>Always open</Badge>
              ) : latest ? (
                <span className="flex flex-wrap items-center gap-2 text-body">
                  <Badge status="tripped">{pauseKindLabel(latest.kind)}</Badge>
                  <span className="text-ink-secondary">
                    for <Countdown target={latest.pausedUntil} now={now} />
                  </span>
                </span>
              ) : (
                <Badge status="open">Open</Badge>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function HoldsCard({ config, now }: { config: Address; now: number }) {
  const holds = useHolds(config);
  const open = (holds.data ?? []).filter(
    (h) => h.account.status === "queued" || h.account.status === "frozen",
  );
  const frozen = open.filter((h) => h.account.status === "frozen").length;
  const claimable = open.filter(
    (h) => h.account.status === "queued" && now >= h.account.releaseAt,
  ).length;
  const waiting = open
    .filter((h) => h.account.status === "queued" && now < h.account.releaseAt)
    .sort((a, b) => a.account.releaseAt - b.account.releaseAt);

  return (
    <Panel
      title="Held withdrawals"
      description="Large withdrawals wait here in public before they can be claimed."
      actions={<CardLink href="/holds">All holds</CardLink>}
    >
      <QueryStatus query={holds} what="held withdrawals" />
      {holds.data === undefined ? null : open.length === 0 ? (
        <p className="text-body text-ink-secondary">
          Nothing is held right now.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Waiting" value={waiting.length} />
            <Stat label="Claimable" value={claimable} />
            <Stat label="Frozen" value={frozen} />
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {open.slice(0, 4).map((h) => {
              const token = tokenInfo(h.account.mint);
              const status: Status =
                h.account.status === "frozen"
                  ? "tripped"
                  : now >= h.account.releaseAt
                    ? "open"
                    : "held";
              return (
                <li
                  key={h.address}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 text-body"
                >
                  <span>
                    <Amount
                      value={h.account.amount}
                      decimals={token.decimals}
                      symbol={token.symbol}
                    />{" "}
                    <span className="text-ink-secondary">
                      to {walletLabel(h.account.owner)}
                    </span>
                  </span>
                  {h.account.status === "frozen" ? (
                    <Badge status={status}>Frozen</Badge>
                  ) : now >= h.account.releaseAt ? (
                    <Badge status={status}>Claimable</Badge>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Badge status={status}>Held</Badge>
                      <Countdown target={h.account.releaseAt} now={now} />
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <InsetPanel className="flex flex-col gap-1 p-3">
      <Label>{label}</Label>
      <span className="font-figure text-h5 font-light tabular-nums">
        {value}
      </span>
    </InsetPanel>
  );
}

function ChangesCard({ config, now }: { config: Address; now: number }) {
  const changes = usePendingChanges(config);
  const waiting = (changes.data ?? []).filter(
    (c) => !c.account.executed && !c.account.vetoed,
  );
  return (
    <Panel
      title="Pending changes"
      description="Anything that loosens protection waits out the timelock, in public, and the guardian can veto it."
      actions={<CardLink href="/rules">Rules</CardLink>}
    >
      <QueryStatus query={changes} what="pending changes" />
      {changes.data === undefined ? null : waiting.length === 0 ? (
        <p className="text-body text-ink-secondary">No change is waiting.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {waiting.map((c) => (
            <li key={c.address} className="flex flex-col gap-2 py-3">
              <span className="text-body">
                {describeAction(c.account.action, tokenInfo)}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-body text-ink-secondary">
                {now >= c.account.executableAt ? (
                  <Badge status="open">Can be executed</Badge>
                ) : (
                  <>
                    <Badge status="held">In the timelock</Badge>
                    executable in{" "}
                    <Countdown target={c.account.executableAt} now={now} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function GuardiansCard({
  config,
  cfg,
  now,
}: {
  config: Address;
  cfg: ProtocolConfig;
  now: number;
}) {
  return (
    <Panel
      title="Guardians"
      description={`Each can pause for up to ${formatSpan(cfg.policy.maxGuardianPauseSecs)} at a time and ${formatSpan(cfg.policy.budgetSecsPerPeriod)} per ${formatSpan(cfg.policy.budgetPeriodSecs)}.`}
    >
      {cfg.guardians.length === 0 ? (
        <p className="text-body text-ink-secondary">
          No guardian. Only the admin can pause.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {cfg.guardians.map((g) => (
            <GuardianRow
              key={g}
              config={config}
              guardian={g}
              policy={cfg.policy}
              now={now}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function GuardianRow({
  config,
  guardian,
  policy,
  now,
}: {
  config: Address;
  guardian: Address;
  policy: PausePolicy;
  now: number;
}) {
  const ledger = useGuardianLedger(config, guardian);
  if (ledger.data === undefined && (ledger.loading || ledger.error)) {
    return (
      <li className="py-3">
        <QueryStatus
          query={ledger}
          what={`${walletLabel(guardian)}'s pause budget`}
          rows={2}
        />
      </li>
    );
  }
  const account = ledger.data?.account ?? null;
  const left = budgetLeft(account, policy, now);
  const ready = account === null ? now : cooldownEnds(account, policy);
  const share = Math.round((left / policy.budgetSecsPerPeriod) * 100);
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-title2 font-medium">{walletLabel(guardian)}</span>
        {now >= ready ? (
          <Badge status="open">Can pause</Badge>
        ) : (
          <span className="flex items-center gap-2 text-body text-ink-secondary">
            <Badge status="held">Cooling down</Badge>
            <Countdown target={ready} now={now} />
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-body">
        <div
          role="meter"
          aria-label="Pause budget left"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
          className="h-2 flex-1 overflow-hidden rounded-full bg-line"
        >
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${share}%` }}
          />
        </div>
        <span className="text-ink-secondary">
          {formatSpan(left)} of pause budget left
        </span>
      </div>
    </li>
  );
}

const severityStatus: Record<Severity, Status | undefined> = {
  critical: "tripped",
  high: "held",
  warning: "held",
  info: undefined,
};

function IncidentsCard({ program }: { program: Address }) {
  const incidents = useIncidents("open");
  const mine = (incidents.data ?? []).filter((i) => i.protocol === program);
  return (
    <Panel
      title="Open incidents"
      description="Raised by the monitor when something needs a person to look."
      actions={<CardLink href="/activity">Activity</CardLink>}
    >
      <QueryStatus query={incidents} what="incidents" />
      {incidents.data === undefined ? null : mine.length === 0 ? (
        <p className="text-body text-ink-secondary">No open incidents.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {mine.slice(0, 5).map((i) => (
            <li
              key={i.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3 text-body"
            >
              <span className="flex flex-col">
                <span>{i.title}</span>
                <span className="text-ink-muted">
                  {formatDateTime(Math.floor(Date.parse(i.opened_at) / 1000))}
                </span>
              </span>
              <Badge status={severityStatus[i.severity]}>{i.severity}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
