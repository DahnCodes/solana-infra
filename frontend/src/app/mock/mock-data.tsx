"use client";

import { FastForward, RotateCcw } from "lucide-react";
import { useState } from "react";
import { Amount } from "@/components/amount";
import { Badge, type Status } from "@/components/badge";
import { Button } from "@/components/button";
import { Countdown } from "@/components/countdown";
import { Input } from "@/components/input";
import { InsetPanel, Panel } from "@/components/panel";
import { ToastProvider, useToast } from "@/components/toast";
import {
  roleOf,
  useChainNow,
  useEvents,
  useFlowLimiters,
  useHolds,
  useIncidents,
  useMockControls,
  usePauseState,
  usePendingChanges,
  usePosition,
  useProtocol,
  useTokenBalance,
  type Role,
} from "@/hooks/use-breakglass";
import { useWrite } from "@/hooks/use-write";
import type {
  AccountRecord,
  Address,
  HoldStatus,
  PendingConfig,
  PendingWithdrawal,
} from "@/lib/breakglass";
import { TEST_VAULT_SCOPE_LABELS } from "@/lib/breakglass/constants";
import { isClientError } from "@/lib/breakglass/errors";
import { walletTokenAccount } from "@/lib/breakglass/mock/engine";
import { MOCK_WALLETS } from "@/lib/breakglass/mock/seed";
import {
  effectiveCap,
  effectiveThreshold,
  windowUsage,
} from "@/lib/breakglass/rules/limiter";
import { runningPauses } from "@/lib/breakglass/rules/pauses";
import { formatDateTime, parseUnits, shortAddress } from "@/lib/format";

const DECIMALS = 6;
const H = 3600;

const walletLabels = new Map<string, string>(
  Object.values(MOCK_WALLETS).map((w) => [w.address, w.label]),
);
const who = (address: Address) =>
  walletLabels.get(address) ?? shortAddress(address);

const holdStatus: Record<HoldStatus, Status | undefined> = {
  queued: "held",
  frozen: "tripped",
  released: "open",
  rejected: undefined,
  claimed: undefined,
};

export function MockData() {
  return (
    <ToastProvider>
      <Body />
    </ToastProvider>
  );
}

function Body() {
  const controls = useMockControls();
  const protocol = useProtocol();
  const config = protocol.data?.address ?? null;
  const role = roleOf(protocol.data?.account, controls?.wallet ?? null);

  if (protocol.loading || !controls) {
    return <p className="text-body text-ink-muted">Loading the demo gate…</p>;
  }
  if (!protocol.data || !config) {
    return (
      <p className="text-body">The demo protocol isn&apos;t registered.</p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Controls />
      <div className="grid gap-6 lg:grid-cols-2">
        <Gate config={config} />
        <YourPosition />
      </div>
      <Holds config={config} role={role} />
      <Changes config={config} role={role} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Activity config={config} />
        <Incidents />
      </div>
    </div>
  );
}

function Controls() {
  const controls = useMockControls()!;
  const now = useChainNow();
  return (
    <Panel
      title="Demo controls"
      description="Act as another wallet, or move the simulated clock forward."
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-2">
          {controls.wallets.map((w) => (
            <Button
              key={w.address}
              variant={controls.wallet === w.address ? "primary" : "secondary"}
              onClick={() => controls.setWallet(w.address)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            icon={<FastForward aria-hidden className="size-4" />}
            onClick={() => controls.advanceClock(H)}
          >
            1 hour
          </Button>
          <Button
            icon={<FastForward aria-hidden className="size-4" />}
            onClick={() => controls.advanceClock(6 * H)}
          >
            6 hours
          </Button>
          <Button
            variant="quiet"
            icon={<RotateCcw aria-hidden className="size-4" />}
            onClick={controls.reset}
          >
            Reset demo
          </Button>
          <span className="text-body text-ink-secondary">
            Chain time: {now === null ? "…" : formatDateTime(now)}
          </span>
        </div>
      </div>
    </Panel>
  );
}

function Gate({ config }: { config: Address }) {
  const now = useChainNow();
  const limiters = useFlowLimiters(config);
  const pauses = usePauseState(config);
  const limiter = limiters.data?.[0];
  const balance = useTokenBalance(limiter?.account.vault ?? null);

  if (!limiter || balance.data === undefined || now === null) {
    return <Panel title="Gate">Loading…</Panel>;
  }
  const l = limiter.account;
  const used = windowUsage(l, now);
  const cap = effectiveCap(l, balance.data);
  const running = runningPauses(pauses.data?.account.active ?? [], now);

  return (
    <Panel title="Gate" description="USDC withdrawals in the rolling hour.">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <span className="font-label text-caption font-semibold text-ink-muted uppercase">
            Window used
          </span>
          <span>
            <Amount value={used} decimals={DECIMALS} size="card" />{" "}
            <span className="text-body text-ink-secondary">
              of <Amount value={cap} decimals={DECIMALS} symbol="USDC" />
            </span>
          </span>
        </div>
        <InsetPanel className="grid gap-2 text-body sm:grid-cols-2">
          <span className="text-ink-secondary">Vault</span>
          <Amount value={balance.data} decimals={DECIMALS} symbol="USDC" />
          <span className="text-ink-secondary">Held from</span>
          <Amount
            value={effectiveThreshold(l, balance.data)}
            decimals={DECIMALS}
            symbol="USDC"
          />
        </InsetPanel>
        <div className="flex flex-col gap-2">
          {running.length === 0 && (
            <Badge status="open">Every scope open</Badge>
          )}
          {running.map((p) => (
            <div
              key={`${p.scope}:${p.kind}:${p.pausedBy}`}
              className="flex flex-wrap items-center justify-between gap-2"
            >
              <Badge status="tripped">
                {TEST_VAULT_SCOPE_LABELS[p.scope]} paused ({p.kind})
              </Badge>
              <Countdown target={p.pausedUntil} now={now} />
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function YourPosition() {
  const controls = useMockControls()!;
  const toast = useToast();
  const wallet = controls.wallet;
  const vault = controls.testVault.vault;
  const position = usePosition(vault, wallet);
  const walletBalance = useTokenBalance(
    wallet ? walletTokenAccount(wallet, controls.testVault.mint) : null,
  );
  const [text, setText] = useState("1,000");
  const amount = parseUnits(text, DECIMALS);

  const withdraw = useWrite((c) =>
    c.withdraw({ vault, amount: amount ?? BigInt(0) }),
  );

  const send = async () => {
    try {
      const result = await withdraw.run();
      if (result.decision === "allow") {
        toast.show({ tone: "open", title: "Withdrawal sent" });
      } else {
        toast.show({
          tone: "held",
          title: "Withdrawal held",
          description: `Claimable ${formatDateTime(result.releaseAt)}.`,
        });
      }
    } catch (error) {
      toast.show({
        tone: "tripped",
        title: "Withdrawal failed",
        description: isClientError(error) ? error.errorName : String(error),
      });
    }
  };

  return (
    <Panel
      title="Your position"
      description={wallet ? `Acting as ${who(wallet)}.` : "No wallet."}
    >
      <div className="flex flex-col gap-6">
        <InsetPanel className="grid gap-2 text-body sm:grid-cols-2">
          <span className="text-ink-secondary">In the vault</span>
          <Amount
            value={position.data?.amount ?? BigInt(0)}
            decimals={DECIMALS}
            symbol="USDC"
          />
          <span className="text-ink-secondary">Held</span>
          <Amount
            value={position.data?.held ?? BigInt(0)}
            decimals={DECIMALS}
            symbol="USDC"
          />
          <span className="text-ink-secondary">In the wallet</span>
          <Amount
            value={walletBalance.data ?? BigInt(0)}
            decimals={DECIMALS}
            symbol="USDC"
          />
        </InsetPanel>
        <div className="flex flex-wrap items-end gap-3">
          <Input
            label="Withdraw"
            value={text}
            onChange={(e) => setText(e.target.value)}
            inputMode="decimal"
            suffix="USDC"
            error={amount === null ? "Enter an amount." : undefined}
            className="min-w-48 flex-1"
          />
          <Button
            variant="primary"
            pending={withdraw.pending}
            disabled={amount === null}
            onClick={send}
          >
            Withdraw
          </Button>
        </div>
        <p className="text-body text-ink-muted">
          Under 100,000 USDC is sent at once; 100,000 or more is held for 6
          hours; past the 150,000 hourly cap, withdrawals pause.
        </p>
      </div>
    </Panel>
  );
}

function Holds({ config, role }: { config: Address; role: Role | null }) {
  const holds = useHolds(config);
  return (
    <Panel
      title="Held withdrawals"
      description={`${holds.data?.length ?? "…"} holds, newest first.`}
    >
      <div className="flex flex-col divide-y divide-line">
        {holds.data?.map((h) => (
          <HoldRow key={h.address} config={config} hold={h} role={role} />
        ))}
      </div>
    </Panel>
  );
}

function HoldRow({
  config,
  hold,
  role,
}: {
  config: Address;
  hold: AccountRecord<PendingWithdrawal>;
  role: Role | null;
}) {
  const controls = useMockControls()!;
  const now = useChainNow();
  const toast = useToast();
  const h = hold.account;
  const args = { config, hold: hold.address };
  const claim = useWrite((c) => c.claimHeld(args));
  const freeze = useWrite((c) => c.freezeHeld(args));
  const reject = useWrite((c) => c.rejectHeld(args));

  const act = (name: string, write: { run: () => Promise<unknown> }) => () =>
    write.run().then(
      () => toast.show({ tone: "open", title: `${name} done` }),
      (error: unknown) =>
        toast.show({
          tone: "tripped",
          title: `${name} failed`,
          description: isClientError(error) ? error.errorName : String(error),
        }),
    );

  const live = h.status === "queued" || h.status === "frozen";
  const claimable =
    h.status === "released" ||
    (h.status === "queued" && now !== null && now >= h.releaseAt);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span>
          <Amount value={h.amount} decimals={DECIMALS} symbol="USDC" /> to{" "}
          {who(h.owner)}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-body text-ink-muted">
          <Badge status={holdStatus[h.status]}>{h.status}</Badge>
          <span>{h.kind} hold</span>
          {h.status === "queued" && (
            <Countdown
              target={h.releaseAt}
              now={now ?? undefined}
              doneLabel="Claimable"
            />
          )}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {controls.wallet === h.owner && claimable && (
          <Button pending={claim.pending} onClick={act("Claim", claim)}>
            Claim
          </Button>
        )}
        {(role === "guardian" || role === "admin") && h.status === "queued" && (
          <Button pending={freeze.pending} onClick={act("Freeze", freeze)}>
            Freeze
          </Button>
        )}
        {role === "admin" && live && (
          <Button pending={reject.pending} onClick={act("Reject", reject)}>
            Reject
          </Button>
        )}
      </div>
    </div>
  );
}

function Changes({ config, role }: { config: Address; role: Role | null }) {
  const changes = usePendingChanges(config);
  return (
    <Panel
      title="Pending changes"
      description="Loosening changes wait out the 48-hour timelock."
    >
      <div className="flex flex-col divide-y divide-line">
        {changes.data?.length === 0 && (
          <p className="text-body text-ink-muted">No pending changes.</p>
        )}
        {changes.data?.map((c) => (
          <ChangeRow key={c.address} config={config} change={c} role={role} />
        ))}
      </div>
    </Panel>
  );
}

function ChangeRow({
  config,
  change,
  role,
}: {
  config: Address;
  change: AccountRecord<PendingConfig>;
  role: Role | null;
}) {
  const now = useChainNow();
  const toast = useToast();
  const c = change.account;
  const args = { config, change: change.address };
  const execute = useWrite((client) => client.executeConfig(args));
  const veto = useWrite((client) => client.vetoConfig(args));
  const fail = (name: string) => (error: unknown) =>
    toast.show({
      tone: "tripped",
      title: `${name} failed`,
      description: isClientError(error) ? error.errorName : String(error),
    });
  const state = c.executed ? "executed" : c.vetoed ? "vetoed" : "waiting";

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex flex-col gap-1">
        <span>{c.action.kind}</span>
        <span className="flex flex-wrap items-center gap-2 text-body text-ink-muted">
          <Badge status={state === "waiting" ? "held" : undefined}>
            {state}
          </Badge>
          {state === "waiting" && (
            <Countdown
              target={c.executableAt}
              now={now ?? undefined}
              doneLabel="Executable"
            />
          )}
        </span>
      </div>
      {state === "waiting" && (
        <div className="flex gap-2">
          <Button
            pending={execute.pending}
            onClick={() => execute.run().catch(fail("Execute"))}
          >
            Execute
          </Button>
          {role === "guardian" && (
            <Button
              pending={veto.pending}
              onClick={() => veto.run().catch(fail("Veto"))}
            >
              Veto
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Activity({ config }: { config: Address }) {
  const events = useEvents(config, 8);
  return (
    <Panel title="Activity" description="The newest Breakglass events.">
      <ul className="flex flex-col divide-y divide-line">
        {events.data?.items.map((r, i) => (
          <li
            key={`${r.signature}:${i}`}
            className="flex justify-between gap-3 py-2 text-body"
          >
            <span>{r.event.name}</span>
            <span className="text-ink-muted">
              {formatDateTime(r.blockTime)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Incidents() {
  const incidents = useIncidents();
  return (
    <Panel title="Incidents" description="Opened by the monitor's detectors.">
      <ul className="flex flex-col divide-y divide-line">
        {incidents.data?.slice(0, 8).map((i) => (
          <li
            key={i.id}
            className="flex flex-wrap justify-between gap-2 py-2 text-body"
          >
            <span>{i.title}</span>
            <Badge
              status={
                i.status === "open"
                  ? i.severity === "critical"
                    ? "tripped"
                    : "held"
                  : undefined
              }
            >
              {i.status}
            </Badge>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
