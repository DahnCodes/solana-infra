"use client";

import { Snowflake, TriangleAlert, Undo2, Unlock } from "lucide-react";
import { useState } from "react";
import { Amount } from "@/components/amount";
import { Badge, type Status } from "@/components/badge";
import { ActionButton } from "@/components/action-button";
import { Countdown } from "@/components/countdown";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import {
  roleOf,
  useChainNow,
  useConnectedWallet,
  useEvents,
  useFlowLimiters,
  useHolds,
  usePauseState,
  usePendingChanges,
  useProtocol,
  useTokenBalance,
  type Role,
} from "@/hooks/use-breakglass";
import type {
  AccountRecord,
  Address,
  BreakglassEventRecord,
  ClaimResult,
  HoldKind,
  PendingConfig,
  PendingWithdrawal,
} from "@/lib/breakglass";
import {
  canClaim,
  canExecute,
  canFreeze,
  canProposeRelease,
  canReject,
} from "@/lib/breakglass/permissions";
import { isScopePaused } from "@/lib/breakglass/rules/pauses";
import { holdRiskFlags } from "@/lib/breakglass/risk";
import { cx } from "@/lib/cx";
import { formatDateTime, formatUnits } from "@/lib/format";
import { tokenInfo } from "@/lib/tokens";
import { walletLabel } from "@/lib/wallet-label";

type Filter = "attention" | "all" | "settled";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "attention", label: "Open" },
  { id: "settled", label: "Settled" },
  { id: "all", label: "All" },
];

const isOpen = (h: PendingWithdrawal) =>
  h.status === "queued" || h.status === "frozen" || h.status === "released";

const KIND: Record<HoldKind, string> = {
  large: "Held for size",
  limit: "Held at the cap",
  screen: "Held for screening",
};

/** Every held withdrawal, with its countdown, risk flags and what you can do. */
export function WaitingRoom() {
  const protocol = useProtocol();
  const config = protocol.data?.address ?? null;
  const wallet = useConnectedWallet();
  const role = roleOf(protocol.data?.account, wallet);
  const now = useChainNow();
  const holds = useHolds(config);
  const changes = usePendingChanges(config);
  const events = useEvents(config, 500);
  const pauses = usePauseState(config);
  const [filter, setFilter] = useState<Filter>("attention");

  const all = holds.data ?? [];
  const shown = all.filter((h) =>
    filter === "all"
      ? true
      : filter === "attention"
        ? isOpen(h.account)
        : !isOpen(h.account),
  );
  const count = (f: Filter) =>
    all.filter((h) =>
      f === "all"
        ? true
        : f === "attention"
          ? isOpen(h.account)
          : !isOpen(h.account),
    ).length;

  return (
    <>
      <PageHeader
        title="Held withdrawals"
        description="Large withdrawals wait here, in public, before they can be claimed. The guardian can freeze one; the admin can reject it or release it through the timelock."
      />
      <Panel
        actions={
          <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
                className={cx(
                  "h-9 rounded-control border px-3 text-body",
                  filter === f.id
                    ? "border-primary bg-primary text-on-primary"
                    : "border-line-strong bg-surface text-ink hover:bg-surface-inset",
                )}
              >
                {f.label} ({count(f.id)})
              </button>
            ))}
          </div>
        }
        title={
          role
            ? `You're acting as ${roleName(role)}`
            : "Connect a wallet to act"
        }
        description={
          role === "guardian"
            ? "You can freeze a waiting hold that looks wrong."
            : role === "admin"
              ? "You can freeze, reject, or release a frozen hold through the timelock."
              : role === "user"
                ? "You can claim your own holds once they unlock."
                : "Anyone can see every hold."
        }
      >
        {holds.loading || now === null || !config ? (
          <p className="text-body text-ink-muted">Loading holds…</p>
        ) : shown.length === 0 ? (
          <p className="text-body text-ink-secondary">
            {filter === "attention"
              ? "Nothing is held right now."
              : "No holds here."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {shown.map((h) => (
              <HoldRow
                key={h.address}
                config={config}
                hold={h}
                role={role}
                wallet={wallet}
                now={now}
                history={events.data?.items ?? []}
                pendingRelease={
                  (changes.data ?? []).find(
                    (c) =>
                      c.account.action.kind === "releaseHeld" &&
                      c.account.action.hold === h.address &&
                      !c.account.executed &&
                      !c.account.vetoed,
                  ) ?? null
                }
                scopePaused={isScopePaused(
                  pauses.data?.account.active ?? [],
                  h.account.scope,
                  now,
                )}
              />
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

const roleName = (role: Role) =>
  role === "admin"
    ? "the admin"
    : role === "guardian"
      ? "a guardian"
      : "a user";

function statusOf(
  h: PendingWithdrawal,
  now: number,
): { label: string; status?: Status } {
  switch (h.status) {
    case "queued":
      return now >= h.releaseAt
        ? { label: "Claimable", status: "open" }
        : { label: "Held", status: "held" };
    case "frozen":
      return { label: "Frozen", status: "tripped" };
    case "released":
      return { label: "Released: claimable", status: "open" };
    case "rejected":
      return { label: "Rejected: returned to the position" };
    case "claimed":
      return { label: "Claimed" };
  }
}

function HoldRow({
  config,
  hold,
  role,
  wallet,
  now,
  history,
  pendingRelease,
  scopePaused,
}: {
  config: Address;
  hold: AccountRecord<PendingWithdrawal>;
  role: Role | null;
  wallet: Address | null;
  now: number;
  history: BreakglassEventRecord[];
  pendingRelease: AccountRecord<PendingConfig> | null;
  scopePaused: boolean;
}) {
  const h = hold.account;
  const token = tokenInfo(h.mint);
  const limiters = useFlowLimiters(config);
  const vault =
    limiters.data?.find((l) => l.account.mint === h.mint)?.account.vault ??
    null;
  const balance = useTokenBalance(vault);
  const flags = isOpen(h)
    ? holdRiskFlags(h, balance.data ?? null, history)
    : [];
  const status = statusOf(h, now);
  const amountText = `${formatUnits(h.amount, token.decimals)} ${token.symbol}`;
  const args = { config, hold: hold.address };

  return (
    <li className="flex flex-col gap-3 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-title1">
            <Amount
              value={h.amount}
              decimals={token.decimals}
              symbol={token.symbol}
            />
            <span className="text-body text-ink-secondary">
              {" "}
              to {walletLabel(h.owner)}
            </span>
          </span>
          <span className="text-body text-ink-muted">
            {KIND[h.kind]}, since {formatDateTime(h.createdAt)}
          </span>
        </div>
        <span className="flex flex-wrap items-center gap-2 text-body">
          <Badge status={status.status}>{status.label}</Badge>
          {h.status === "queued" && now < h.releaseAt && (
            <span className="text-ink-secondary">
              unlocks in <Countdown target={h.releaseAt} now={now} />
            </span>
          )}
        </span>
      </div>

      {flags.length > 0 && (
        <ul aria-label="Risk flags" className="flex flex-wrap gap-2">
          {flags.map((f) => (
            <li
              key={f.id}
              className="inline-flex items-center gap-1.5 rounded-control border border-line px-2 py-1 text-body text-ink-secondary"
            >
              <TriangleAlert aria-hidden className="size-3.5 text-held" />
              {f.label}
            </li>
          ))}
        </ul>
      )}

      {pendingRelease && (
        <p className="text-body text-ink-secondary">
          {now >= pendingRelease.account.executableAt ? (
            "The release has passed the timelock and can be executed."
          ) : (
            <>
              Release proposed: executable in{" "}
              <Countdown
                target={pendingRelease.account.executableAt}
                now={now}
              />
              , unless the guardian vetoes it.
            </>
          )}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <ActionButton
          label="Claim"
          done={(r: ClaimResult) =>
            r.decision === "allow"
              ? {
                  tone: "open",
                  title: "Claimed",
                  description: "It's in your wallet now.",
                }
              : {
                  tone: "held",
                  title: "Not claimed yet",
                  description:
                    "Claiming now would cross the window's cap, so withdrawals paused. Try again once the window frees up.",
                }
          }
          permission={canClaim(wallet, h, now, scopePaused)}
          relevant={wallet === h.owner && isOpen(h)}
          confirm={{
            title: "Claim this withdrawal?",
            summary:
              "The protocol pays it out to your wallet. It counts against the window's cap, so if the cap is nearly used, the claim waits and withdrawals pause.",
            details: [{ label: "Amount", value: amountText }],
          }}
          run={(c) => c.claimHeld(args)}
        />
        <ActionButton
          label="Freeze"
          done="Hold frozen"
          icon={<Snowflake aria-hidden className="size-4" />}
          permission={canFreeze(role, h)}
          relevant={
            (role === "guardian" || role === "admin") && h.status === "queued"
          }
          confirm={{
            title: "Freeze this hold?",
            summary: `${walletLabel(h.owner)} won't be able to claim it. Only the admin can then reject it or release it through the timelock.`,
            details: [
              { label: "Amount", value: amountText },
              { label: "To", value: walletLabel(h.owner) },
            ],
            confirmLabel: "Freeze hold",
          }}
          run={(c) => c.freezeHeld(args)}
        />
        <ActionButton
          label="Reject"
          done="Hold rejected: the funds are back in the position"
          icon={<Undo2 aria-hidden className="size-4" />}
          permission={canReject(role, h)}
          relevant={role === "admin" && isOpen(h)}
          confirm={{
            title: "Reject this withdrawal?",
            summary: `Nothing is paid out. The amount goes back to ${walletLabel(h.owner)}'s position in the protocol, at once.`,
            details: [
              { label: "Amount", value: amountText },
              { label: "Returned to", value: walletLabel(h.owner) },
            ],
            confirmLabel: "Reject withdrawal",
          }}
          run={(c) => c.rejectHeld(args)}
        />
        <ActionButton
          label="Release through the timelock"
          done="Release proposed"
          icon={<Unlock aria-hidden className="size-4" />}
          permission={canProposeRelease(
            role,
            h,
            pendingRelease?.account ?? null,
          )}
          relevant={role === "admin" && h.status === "frozen"}
          confirm={{
            title: "Release this frozen withdrawal?",
            summary:
              "Releasing loosens protection, so it is proposed now and waits out the timelock in public. The guardian can veto it meanwhile; after that, anyone can execute it and the owner can claim.",
            details: [
              { label: "Amount", value: amountText },
              { label: "To", value: walletLabel(h.owner) },
            ],
            confirmLabel: "Propose release",
          }}
          run={(c) => c.releaseHeld(args)}
        />
        {pendingRelease && (
          <ActionButton
            label="Execute the release"
            done="Release executed: the hold can be claimed"
            permission={canExecute(wallet, pendingRelease.account, now)}
            confirm={{
              title: "Execute the release?",
              summary:
                "The timelock has passed and nobody vetoed it. The hold becomes claimable by its owner.",
              details: [{ label: "Amount", value: amountText }],
            }}
            run={(c) =>
              c.executeConfig({ config, change: pendingRelease.address })
            }
          />
        )}
      </div>
    </li>
  );
}
