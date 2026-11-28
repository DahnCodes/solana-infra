"use client";

import { Pause, Play, Plus, RotateCw, ShieldOff } from "lucide-react";
import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Countdown } from "@/components/countdown";
import { Dialog } from "@/components/dialog";
import { Input } from "@/components/input";
import { PageHeader } from "@/components/page-header";
import { InsetPanel, Panel } from "@/components/panel";
import { Select } from "@/components/select";
import { useTx } from "@/components/tx/tx-provider";
import {
  roleOf,
  useChainNow,
  useConnectedWallet,
  useFlowLimiters,
  useGuardianLedger,
  usePauseState,
  usePendingChanges,
  useProtocol,
  type Role,
} from "@/hooks/use-breakglass";
import type {
  AccountRecord,
  Address,
  ConfigAction,
  FlowLimiter,
  GuardianLedger,
  PauseState,
  PendingConfig,
  ProtocolConfig,
} from "@/lib/breakglass";
import { scopeMask, scopesInMask } from "@/lib/breakglass/constants";
import {
  describeAction,
  formatSpan,
  pauseKindLabel,
  scopeLabel,
} from "@/lib/breakglass/describe";
import {
  canCancel,
  canExecute,
  canPause,
  canPropose,
  canRemoveGuardian,
  canRenew,
  canUnpause,
  canVeto,
} from "@/lib/breakglass/permissions";
import {
  budgetLeft,
  cooldownEnds,
  runningPauses,
} from "@/lib/breakglass/rules/pauses";
import { cx } from "@/lib/cx";
import { formatDateTime, formatUnits, parseUnits } from "@/lib/format";
import { tokenInfo } from "@/lib/tokens";
import { walletLabel } from "@/lib/wallet-label";

const H = 3600;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Pause controls, guardians and the timelocked config changes. */
export function RulesPanel() {
  const protocol = useProtocol();
  const wallet = useConnectedWallet();
  const now = useChainNow();
  const config = protocol.data?.address ?? null;
  const pauses = usePauseState(config);
  const limiters = useFlowLimiters(config);
  const changes = usePendingChanges(config);
  const ledger = useGuardianLedger(config, wallet);
  const cfg = protocol.data?.account;
  const role = roleOf(cfg, wallet);

  const ready = cfg && config && pauses.data && limiters.data && now !== null;

  return (
    <>
      <PageHeader
        title="Pauses and rules"
        description="Pausing tightens protection, so it applies at once. Anything that loosens it waits out the timelock, in public, where the guardian can veto it."
      />
      {!ready ? (
        <p className="text-body text-ink-muted">Loading the rules…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <PausesCard
            cfg={cfg}
            config={config}
            state={pauses.data!.account}
            limiters={limiters.data!}
            ledger={ledger.data?.account ?? null}
            wallet={wallet}
            role={role}
            now={now}
          />
          <GuardiansCard cfg={cfg} config={config} role={role} />
          <ChangesCard
            cfg={cfg}
            config={config}
            changes={changes.data ?? []}
            limiters={limiters.data!}
            wallet={wallet}
            role={role}
            now={now}
          />
        </div>
      )}
    </>
  );
}

// Pauses -------------------------------------------------------------------------

function PausesCard({
  cfg,
  config,
  state,
  limiters,
  ledger,
  wallet,
  role,
  now,
}: {
  cfg: ProtocolConfig;
  config: Address;
  state: PauseState;
  limiters: AccountRecord<FlowLimiter>[];
  ledger: GuardianLedger | null;
  wallet: Address | null;
  role: Role | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const ctx = {
    config: cfg,
    configAddress: config,
    state,
    ledger,
    wallet,
    now,
  };
  const running = runningPauses(state.active, now);
  const always = scopesInMask(cfg.unpausableMask);
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
  const policy = cfg.policy;

  return (
    <Panel
      title="Pauses"
      description="Stop a scope during an incident. Scopes that are always open can never be paused."
      className="lg:col-span-2"
      actions={
        (role === "admin" || role === "guardian") && (
          <Button
            variant="primary"
            icon={<Pause aria-hidden className="size-4" />}
            onClick={() => setOpen(true)}
          >
            Pause scopes
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {role === "guardian" && (
          <InsetPanel className="flex flex-col gap-1 text-body">
            <span>
              As a guardian you can pause for up to{" "}
              {formatSpan(policy.maxGuardianPauseSecs)} at a time, extend your
              own pause {policy.maxRenewals} times, and lift only your own
              pauses.
            </span>
            <span className="text-ink-secondary">
              Budget left: {formatSpan(budgetLeft(ledger, policy, now))} of{" "}
              {formatSpan(policy.budgetSecsPerPeriod)} this period.{" "}
              {ledger && now < cooldownEnds(ledger, policy) ? (
                <>
                  Cooling down for{" "}
                  <Countdown target={cooldownEnds(ledger, policy)} now={now} />.
                </>
              ) : (
                "You can pause now."
              )}
            </span>
          </InsetPanel>
        )}
        <ul className="flex flex-col divide-y divide-line">
          {scopes.map((scope) => {
            const entries = running.filter((p) => p.scope === scope);
            const latest = entries.reduce<(typeof entries)[number] | null>(
              (a, p) => (!a || p.pausedUntil > a.pausedUntil ? p : a),
              null,
            );
            const mask = scopeMask(scope);
            return (
              <li
                key={scope}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="flex flex-col gap-1">
                  <span className="text-title2 font-medium">
                    {scopeLabel(scope)}
                  </span>
                  {latest && (
                    <span className="text-body text-ink-secondary">
                      {entries.map((e) => pauseKindLabel(e.kind)).join(", ")}
                      {entries.length === 1 &&
                        pausedByNote(entries[0].pausedBy, entries[0].kind)}{" "}
                      for <Countdown target={latest.pausedUntil} now={now} />
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {always.includes(scope) ? (
                    <Badge>Always open</Badge>
                  ) : latest ? (
                    <>
                      <ActionButton
                        label="Extend"
                        done={`${scopeLabel(scope)} pause extended`}
                        icon={<RotateCw aria-hidden className="size-4" />}
                        permission={canRenew(ctx, mask)}
                        relevant={role === "admin" || role === "guardian"}
                        confirm={{
                          title: `Extend the pause on ${scopeLabel(scope).toLowerCase()}?`,
                          summary:
                            `It stays paused for another ${formatSpan(cfg.policy.maxGuardianPauseSecs)} from its current end. ` +
                            (role === "guardian"
                              ? `This uses ${formatSpan(cfg.policy.maxGuardianPauseSecs)} of your pause budget.`
                              : "As the admin's extension, only the admin can lift it."),
                          confirmLabel: "Extend pause",
                        }}
                        run={(c) => c.renewPause({ config, scopes: mask })}
                      />
                      <ActionButton
                        label="Lift"
                        done={`${scopeLabel(scope)} reopened`}
                        icon={<Play aria-hidden className="size-4" />}
                        permission={canUnpause(ctx, mask)}
                        relevant={role === "admin" || role === "guardian"}
                        confirm={{
                          title: `Lift the pause on ${scopeLabel(scope).toLowerCase()}?`,
                          summary: `${scopeLabel(scope)} reopen at once. Every pause on this scope that you're allowed to lift ends now.`,
                          confirmLabel: "Lift pause",
                        }}
                        run={(c) => c.unpause({ config, scopes: mask })}
                      />
                      <Badge status="tripped">Paused</Badge>
                    </>
                  ) : (
                    <Badge status="open">Open</Badge>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <PauseDialog
        open={open}
        onClose={() => setOpen(false)}
        scopes={scopes.filter((s) => !always.includes(s))}
        role={role}
        ctx={ctx}
      />
    </Panel>
  );
}

const pausedByNote = (by: Address, kind: string) =>
  kind === "autoTrip" ? "" : ` (${walletLabel(by)})`;

function PauseDialog({
  open,
  onClose,
  scopes,
  role,
  ctx,
}: {
  open: boolean;
  onClose: () => void;
  scopes: number[];
  role: Role | null;
  ctx: Parameters<typeof canPause>[0];
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [hours, setHours] = useState("6");
  const [reason, setReason] = useState("0");
  const max = ctx.config.policy.maxGuardianPauseSecs / H;
  const options =
    role === "admin"
      ? [1, 6, 12, 24, 48, 72, 168]
      : [1, 6, 12, 24].filter((h) => h <= max);
  const mask = picked.length ? scopeMask(...picked) : BigInt(0);
  const duration = Number(hours) * H;
  const reasonCode = Number(reason);
  const reasonOk =
    Number.isInteger(reasonCode) && reasonCode >= 0 && reasonCode <= 65535;
  const permission = picked.length
    ? canPause(ctx, mask, duration)
    : ({ allowed: false, reason: "Pick at least one scope." } as const);
  const tx = useTx();
  const [sending, setSending] = useState(false);
  const names = picked.map((s) => scopeLabel(s).toLowerCase()).join(", ");
  const sendPause = async () => {
    onClose();
    await tx.send({
      title: `Pause ${names}?`,
      summary:
        role === "guardian"
          ? `${capitalize(names)} stop until the pause ends or you lift it. Afterwards you cool down for ${formatSpan(ctx.config.policy.cooldownSecs)} before you can pause again.`
          : `${capitalize(names)} stop until the pause ends or it's lifted. Only the admin can lift an admin pause.`,
      details: [
        { label: "Scopes", value: names },
        { label: "For", value: formatSpan(duration) },
        { label: "Reason code", value: String(reasonCode) },
      ],
      confirmLabel: "Pause",
      onStart: () => setSending(true),
      run: (c) =>
        c.pause({
          config: ctx.configAddress,
          scopes: mask,
          duration,
          reason: reasonCode,
        }),
      done: { tone: "tripped", title: `Paused for ${formatSpan(duration)}` },
    });
    setSending(false);
    setPicked([]);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pause scopes"
      description={
        role === "guardian"
          ? "Pause everything you need in one go: after a pause, you cool down before you can pause again."
          : "The admin can pause for any length, and only the admin can lift an admin pause."
      }
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Pause aria-hidden className="size-4" />}
            pending={sending}
            disabled={!permission.allowed || !reasonOk}
            onClick={sendPause}
          >
            Pause
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-title2 font-medium">Scopes</legend>
          <div className="flex flex-wrap gap-2">
            {scopes.map((s) => {
              const on = picked.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setPicked(
                      on ? picked.filter((x) => x !== s) : [...picked, s],
                    )
                  }
                  className={cx(
                    "h-9 rounded-control border px-3 text-body",
                    on
                      ? "border-primary bg-primary text-on-primary"
                      : "border-line-strong bg-surface text-ink hover:bg-surface-inset",
                  )}
                >
                  {scopeLabel(s)}
                </button>
              );
            })}
          </div>
        </fieldset>
        <Select
          label="For"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          options={options.map((h) => ({
            value: String(h),
            label: formatSpan(h * H),
          }))}
        />
        <Input
          label="Reason code"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          inputMode="numeric"
          error={reasonOk ? undefined : "A whole number from 0 to 65535."}
          hint="Your own code for why, recorded with the pause. 0 if none."
        />
        {picked.length > 0 && !permission.allowed && (
          <p role="alert" className="text-body">
            {permission.reason}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// Guardians ----------------------------------------------------------------------

function GuardiansCard({
  cfg,
  config,
  role,
}: {
  cfg: ProtocolConfig;
  config: Address;
  role: Role | null;
}) {
  return (
    <Panel
      title="Guardians"
      description="The admin can remove a guardian at once. Adding one loosens protection, so it goes through the timelock."
    >
      {cfg.guardians.length === 0 ? (
        <p className="text-body text-ink-secondary">
          No guardian. Only the admin can pause.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {cfg.guardians.map((g) => (
            <li
              key={g}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <span className="flex flex-col">
                <span className="text-title2 font-medium">
                  {walletLabel(g)}
                </span>
                <span className="text-body break-all text-ink-muted">{g}</span>
              </span>
              <ActionButton
                label="Remove"
                done="Guardian removed"
                icon={<ShieldOff aria-hidden className="size-4" />}
                permission={canRemoveGuardian(role)}
                relevant={role === "admin"}
                confirm={{
                  title: `Remove ${walletLabel(g)} as a guardian?`,
                  summary:
                    "It loses every power at once. Its running pauses stay until they end or you lift them.",
                  details: [{ label: "Guardian", value: g }],
                  confirmLabel: "Remove guardian",
                }}
                run={(c) => c.removeGuardian({ config, guardian: g })}
              />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-body text-ink-muted">
        Admin: {walletLabel(cfg.admin)}
      </p>
    </Panel>
  );
}

// Changes ------------------------------------------------------------------------

function ChangesCard({
  cfg,
  config,
  changes,
  limiters,
  wallet,
  role,
  now,
}: {
  cfg: ProtocolConfig;
  config: Address;
  changes: AccountRecord<PendingConfig>[];
  limiters: AccountRecord<FlowLimiter>[];
  wallet: Address | null;
  role: Role | null;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title="Config changes"
      description={`Each waits ${formatSpan(cfg.timelockSecs)} before anyone can execute it.`}
      actions={
        canPropose(role).allowed && (
          <Button
            icon={<Plus aria-hidden className="size-4" />}
            onClick={() => setOpen(true)}
          >
            Propose a change
          </Button>
        )
      }
    >
      {changes.length === 0 ? (
        <p className="text-body text-ink-secondary">No changes proposed.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {changes.map((c) => {
            const a = c.account;
            const args = { config, change: c.address };
            return (
              <li key={c.address} className="flex flex-col gap-2 py-3">
                <span className="text-body">
                  {describeAction(a.action, tokenInfo)}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-body text-ink-secondary">
                  {a.executed ? (
                    <Badge>Done</Badge>
                  ) : a.vetoed ? (
                    <Badge status="tripped">Vetoed</Badge>
                  ) : now >= a.executableAt ? (
                    <Badge status="open">Can be executed</Badge>
                  ) : (
                    <>
                      <Badge status="held">In the timelock</Badge>
                      <Countdown target={a.executableAt} now={now} /> left
                    </>
                  )}
                  <span>Proposed {formatDateTime(a.proposedAt)}</span>
                </span>
                {!a.executed && !a.vetoed && (
                  <div className="flex flex-wrap gap-2">
                    <ActionButton
                      label="Execute"
                      done="Change executed"
                      permission={canExecute(wallet, a, now)}
                      confirm={{
                        title: "Execute this change?",
                        summary: `It takes effect now: ${describeAction(a.action, tokenInfo)}.`,
                        confirmLabel: "Execute change",
                      }}
                      run={(cl) => cl.executeConfig(args)}
                    />
                    <ActionButton
                      label="Veto"
                      done="Change vetoed"
                      permission={canVeto(role, a)}
                      relevant={role === "guardian"}
                      confirm={{
                        title: "Veto this change?",
                        summary: `It can never be executed: ${describeAction(a.action, tokenInfo)}.`,
                        confirmLabel: "Veto change",
                      }}
                      run={(cl) => cl.vetoConfig(args)}
                    />
                    <ActionButton
                      label="Cancel"
                      variant="quiet"
                      done="Change cancelled"
                      permission={canCancel(role, a)}
                      relevant={role === "admin"}
                      confirm={{
                        title: "Cancel this change?",
                        summary: `Your proposal is withdrawn: ${describeAction(a.action, tokenInfo)}.`,
                        confirmLabel: "Cancel change",
                      }}
                      run={(cl) => cl.cancelConfig(args)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ProposeDialog
        open={open}
        onClose={() => setOpen(false)}
        cfg={cfg}
        config={config}
        limiters={limiters}
      />
    </Panel>
  );
}

type Kind = Exclude<ConfigAction["kind"], "releaseHeld">;

const KINDS: { value: Kind; label: string }[] = [
  { value: "raiseLimits", label: "Change a token's limits" },
  { value: "addGuardian", label: "Add a guardian" },
  { value: "setAdmin", label: "Hand over the admin role" },
  { value: "changePolicy", label: "Change the guardian pause limits" },
];

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const pct = (bps: number) => String(bps / 100);
const toBps = (t: string) => {
  const n = Number(t);
  return t.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100
    ? Math.round(n * 100)
    : null;
};
const hoursOf = (t: string) => {
  const n = Number(t);
  return t.trim() !== "" && Number.isFinite(n) && n > 0
    ? Math.round(n * H)
    : null;
};

function ProposeDialog({
  open,
  onClose,
  cfg,
  config,
  limiters,
}: {
  open: boolean;
  onClose: () => void;
  cfg: ProtocolConfig;
  config: Address;
  limiters: AccountRecord<FlowLimiter>[];
}) {
  const first = limiters[0]?.account;
  const firstToken = first ? tokenInfo(first.mint) : null;
  const [kind, setKind] = useState<Kind>("raiseLimits");
  const [mint, setMint] = useState(first?.mint ?? "");
  const [cap, setCap] = useState(
    first && firstToken
      ? formatUnits(first.capAbsolute, firstToken.decimals)
      : "",
  );
  const [capPct, setCapPct] = useState(first ? pct(first.capBpsOfVault) : "0");
  const [threshold, setThreshold] = useState(
    first && firstToken
      ? formatUnits(first.largeThreshold, firstToken.decimals)
      : "",
  );
  const [thresholdPct, setThresholdPct] = useState(
    first ? pct(first.largeThresholdBps) : "0",
  );
  const [address, setAddress] = useState("");
  const p = cfg.policy;
  const [maxPause, setMaxPause] = useState(String(p.maxGuardianPauseSecs / H));
  const [renewals, setRenewals] = useState(String(p.maxRenewals));
  const [cooldown, setCooldown] = useState(String(p.cooldownSecs / H));
  const [budget, setBudget] = useState(String(p.budgetSecsPerPeriod / H));
  const [period, setPeriod] = useState(String(p.budgetPeriodSecs / H / 24));
  const [autoTrip, setAutoTrip] = useState(String(p.autoTripSecs / H));

  const token = tokenInfo(mint);
  const action: ConfigAction | null = (() => {
    switch (kind) {
      case "raiseLimits": {
        const capUnits = parseUnits(cap, token.decimals);
        const thrUnits = parseUnits(threshold, token.decimals);
        const capBps = toBps(capPct);
        const thrBps = toBps(thresholdPct);
        if (
          !mint ||
          !capUnits ||
          !thrUnits ||
          capBps === null ||
          thrBps === null
        )
          return null;
        return {
          kind,
          mint,
          capAbsolute: capUnits,
          capBpsOfVault: capBps,
          largeThreshold: thrUnits,
          largeThresholdBps: thrBps,
        };
      }
      case "addGuardian":
        return ADDRESS.test(address.trim())
          ? { kind, guardian: address.trim() }
          : null;
      case "setAdmin":
        return ADDRESS.test(address.trim())
          ? { kind, admin: address.trim() }
          : null;
      case "changePolicy": {
        const values = [
          hoursOf(maxPause),
          hoursOf(cooldown),
          hoursOf(budget),
          hoursOf(autoTrip),
        ];
        const days = Number(period);
        const r = Number(renewals);
        if (
          values.some((v) => v === null) ||
          !(days > 0) ||
          !Number.isInteger(r) ||
          r < 0 ||
          r > 255
        )
          return null;
        return {
          kind,
          policy: {
            maxGuardianPauseSecs: values[0]!,
            maxRenewals: r,
            cooldownSecs: values[1]!,
            budgetSecsPerPeriod: values[2]!,
            budgetPeriodSecs: Math.round(days * 24 * H),
            autoTripSecs: values[3]!,
          },
        };
      }
    }
  })();

  const tx = useTx();
  const [sending, setSending] = useState(false);
  const sendProposal = async () => {
    if (!action) return;
    onClose();
    await tx.send({
      title: "Propose this change?",
      summary: `${describeAction(action, tokenInfo)}. It waits ${formatSpan(cfg.timelockSecs)} in public, where the guardian can veto it; after that, anyone can execute it.`,
      details: [
        { label: "Timelock", value: formatSpan(cfg.timelockSecs) },
        { label: "Can be vetoed by", value: "Any guardian" },
      ],
      confirmLabel: "Propose change",
      onStart: () => setSending(true),
      run: (c) => c.proposeConfig({ config, action }),
      done: {
        tone: "held",
        title: "Change proposed",
        description: `It can be executed in ${formatSpan(cfg.timelockSecs)}.`,
      },
    });
    setSending(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Propose a change"
      description={`It waits ${formatSpan(cfg.timelockSecs)} in public. The guardian can veto it meanwhile; after that, anyone can execute it.`}
      actions={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={sending}
            disabled={!action}
            onClick={sendProposal}
          >
            Propose
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="Change"
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind)}
          options={KINDS}
        />
        {kind === "raiseLimits" && (
          <>
            <Select
              label="Token"
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              options={limiters.map((l) => ({
                value: l.account.mint,
                label: tokenInfo(l.account.mint).symbol,
              }))}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Input
                label="Cap per window"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                inputMode="decimal"
                suffix={token.symbol}
              />
              <Input
                label="Or a share of the vault"
                value={capPct}
                onChange={(e) => setCapPct(e.target.value)}
                inputMode="decimal"
                suffix="%"
                hint="0 for none."
              />
              <Input
                label="Hold withdrawals from"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                inputMode="decimal"
                suffix={token.symbol}
              />
              <Input
                label="Or a share of the vault"
                value={thresholdPct}
                onChange={(e) => setThresholdPct(e.target.value)}
                inputMode="decimal"
                suffix="%"
                hint="0 for none."
              />
            </div>
          </>
        )}
        {(kind === "addGuardian" || kind === "setAdmin") && (
          <Input
            label={
              kind === "addGuardian" ? "Guardian address" : "New admin address"
            }
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            error={
              address.trim() && !ADDRESS.test(address.trim())
                ? "Not a Solana address."
                : undefined
            }
            hint={
              kind === "setAdmin" ? "Often a Squads multisig vault." : undefined
            }
          />
        )}
        {kind === "changePolicy" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Longest guardian pause"
              value={maxPause}
              onChange={(e) => setMaxPause(e.target.value)}
              inputMode="decimal"
              suffix="hours"
            />
            <Input
              label="Renewals per pause"
              value={renewals}
              onChange={(e) => setRenewals(e.target.value)}
              inputMode="numeric"
            />
            <Input
              label="Cooldown"
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
              inputMode="decimal"
              suffix="hours"
            />
            <Input
              label="Auto-trip pause"
              value={autoTrip}
              onChange={(e) => setAutoTrip(e.target.value)}
              inputMode="decimal"
              suffix="hours"
            />
            <Input
              label="Pause budget"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
              suffix="hours"
            />
            <Input
              label="Per period of"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              inputMode="decimal"
              suffix="days"
            />
          </div>
        )}
        {action && (
          <InsetPanel className="text-body">
            {describeAction(action, tokenInfo)}.
          </InsetPanel>
        )}
      </div>
    </Dialog>
  );
}
