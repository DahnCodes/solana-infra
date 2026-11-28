"use client";

import {
  ArrowUpFromLine,
  Clock,
  Pause,
  Play,
  Settings2,
  ShieldCheck,
  Snowflake,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { Badge, type Status } from "@/components/badge";
import { Button } from "@/components/button";
import { PageHeader } from "@/components/page-header";
import { QueryStatus } from "@/components/query-state";
import { Panel } from "@/components/panel";
import {
  useConnectedWallet,
  useEvents,
  useHolds,
  useIncidents,
  useProtocol,
} from "@/hooks/use-breakglass";
import type {
  BreakglassEventName,
  BreakglassEventRecord,
  Severity,
} from "@/lib/breakglass";
import { describeEvent } from "@/lib/breakglass/describe";
import { cx } from "@/lib/cx";
import { formatDateTime, shortAddress } from "@/lib/format";
import { tokenInfo } from "@/lib/tokens";
import { walletLabel } from "@/lib/wallet-label";

type Group = "all" | "withdrawals" | "pauses" | "config";

const GROUP_OF: Record<BreakglassEventName, Exclude<Group, "all">> = {
  outflowRecorded: "withdrawals",
  largeWithdrawalQueued: "withdrawals",
  limitHoldQueued: "withdrawals",
  withdrawalScreenQueued: "withdrawals",
  holdFrozen: "withdrawals",
  holdResolved: "withdrawals",
  limitTripped: "pauses",
  paused: "pauses",
  pauseRenewed: "pauses",
  unpaused: "pauses",
  configInitialized: "config",
  guardianRemoved: "config",
  configChangeProposed: "config",
  configChangeExecuted: "config",
  configChangeVetoed: "config",
};

const ICON: Record<BreakglassEventName, LucideIcon> = {
  outflowRecorded: ArrowUpFromLine,
  largeWithdrawalQueued: Clock,
  limitHoldQueued: Clock,
  withdrawalScreenQueued: Clock,
  holdFrozen: Snowflake,
  holdResolved: ShieldCheck,
  limitTripped: TriangleAlert,
  paused: Pause,
  pauseRenewed: Pause,
  unpaused: Play,
  configInitialized: Settings2,
  guardianRemoved: Settings2,
  configChangeProposed: Settings2,
  configChangeExecuted: Settings2,
  configChangeVetoed: Settings2,
};

const GROUPS: { id: Group; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "withdrawals", label: "Withdrawals and holds" },
  { id: "pauses", label: "Pauses" },
  { id: "config", label: "Config" },
];

const PAGE = 25;

/** Every Breakglass event with its time and who did it, plus incidents. */
export function ActivityFeed() {
  const protocol = useProtocol();
  const config = protocol.data?.address ?? null;
  const [limit, setLimit] = useState(PAGE);
  const [group, setGroup] = useState<Group>("all");
  const events = useEvents(config, limit);
  const holds = useHolds(config);

  const holdMap = new Map(
    (holds.data ?? []).map((h) => [h.address, h.account]),
  );
  const ctx = {
    token: tokenInfo,
    who: walletLabel,
    hold: (a: string) => holdMap.get(a) ?? null,
    time: formatDateTime,
  };
  const items = (events.data?.items ?? []).filter(
    (r) => group === "all" || GROUP_OF[r.event.name] === group,
  );

  return (
    <>
      <PageHeader
        title="Activity"
        description="Every change the gate records, newest first, and the incidents the monitor raised."
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Panel
          title="Events"
          actions={
            <div
              role="group"
              aria-label="Show"
              className="flex flex-wrap gap-2"
            >
              {GROUPS.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={group === g.id}
                  onClick={() => setGroup(g.id)}
                  className={cx(
                    "h-9 rounded-control border px-3 text-body",
                    group === g.id
                      ? "border-primary bg-primary text-on-primary"
                      : "border-line-strong bg-surface text-ink hover:bg-surface-inset",
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
          }
        >
          {protocol.data === undefined ? (
            <QueryStatus query={protocol} what="the protocol" rows={6} />
          ) : (
            <QueryStatus query={events} what="events" rows={6} />
          )}
          {events.data === undefined ? null : items.length === 0 ? (
            <p className="text-body text-ink-secondary">
              {group === "all"
                ? "Nothing has happened yet."
                : "Nothing of this kind yet."}
            </p>
          ) : (
            <ol className="flex flex-col divide-y divide-line">
              {items.map((r, i) => (
                <EventRow
                  key={`${r.signature}:${r.event.name}:${i}`}
                  record={r}
                  text={describeEvent(r.event, ctx)}
                />
              ))}
            </ol>
          )}
          {events.data?.nextCursor && (
            <div className="mt-4">
              <Button onClick={() => setLimit((n) => n + PAGE)}>
                Show older events
              </Button>
            </div>
          )}
        </Panel>
        <IncidentsList />
      </div>
    </>
  );
}

function EventRow({
  record,
  text,
}: {
  record: BreakglassEventRecord;
  text: string;
}) {
  const Icon = ICON[record.event.name];
  const auto =
    record.event.name === "limitTripped" ||
    (record.event.name === "paused" && record.event.data.kind === 1);
  return (
    <li className="flex gap-3 py-3">
      <Icon
        aria-hidden
        className={cx(
          "mt-0.5 size-5 shrink-0",
          auto ? "text-tripped" : "text-ink-secondary",
        )}
      />
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-body">{text}</span>
        <span className="flex flex-wrap gap-x-3 text-body text-ink-muted">
          <span>{formatDateTime(record.blockTime)}</span>
          <span>
            {auto
              ? "By the gate, during a withdrawal"
              : record.signer
                ? `By ${walletLabel(record.signer)}`
                : "Signer unknown"}
          </span>
          <span title={record.signature}>
            Tx {shortAddress(record.signature, 6)}
          </span>
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

function IncidentsList() {
  const incidents = useIncidents();
  const wallet = useConnectedWallet();
  return (
    <Panel
      title="Incidents"
      description="Raised by the monitor. Acknowledging tells others someone is on it."
    >
      <QueryStatus query={incidents} what="incidents" />
      {incidents.data === undefined ? null : incidents.data.length === 0 ? (
        <p className="text-body text-ink-secondary">
          No incidents. The monitor opens one when something needs a person.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {incidents.data!.map((i) => (
            <li key={i.id} className="flex flex-col gap-2 py-3">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body font-medium">{i.title}</span>
                <Badge
                  status={
                    i.status === "open" ? severityStatus[i.severity] : undefined
                  }
                >
                  {i.severity}
                </Badge>
              </span>
              <span className="text-body text-ink-muted">
                Opened{" "}
                {formatDateTime(Math.floor(Date.parse(i.opened_at) / 1000))}
                {i.status === "acked" &&
                  i.acked_by &&
                  `. Acknowledged by ${i.acked_by}.`}
                {i.status === "resolved" && ". Resolved."}
              </span>
              {i.status === "open" && (
                <div>
                  <ActionButton
                    label="Acknowledge"
                    done="Incident acknowledged"
                    confirm={{
                      title: "Acknowledge this incident?",
                      summary: `Others see that ${wallet ? walletLabel(wallet) : "you"} is on it. This goes to the monitor, not the chain: nothing to sign.`,
                      details: [{ label: "Incident", value: i.title }],
                      signs: false,
                    }}
                    permission={
                      wallet
                        ? { allowed: true }
                        : { allowed: false, reason: "Connect a wallet first." }
                    }
                    run={(c) =>
                      c.ackIncident(i.id, {
                        by: wallet ? walletLabel(wallet) : "unknown",
                      })
                    }
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
