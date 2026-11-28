"use client";

import {
  ArrowLeft,
  Check,
  CircleAlert,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Input } from "@/components/input";
import { InsetPanel, Panel } from "@/components/panel";
import { Select } from "@/components/select";
import { useToast } from "@/components/toast";
import { useConnectedWallet, useMockControls } from "@/hooks/use-breakglass";
import { TEST_VAULT_SCOPE_LABELS } from "@/lib/breakglass/constants";
import { getBreakglassClient } from "@/lib/breakglass/create-client";
import { isClientError } from "@/lib/breakglass/errors";
import { MOCK_WALLETS } from "@/lib/breakglass/mock/seed";
import { cx } from "@/lib/cx";
import { formatUnits, parseUnits, shortAddress } from "@/lib/format";
import {
  adminOf,
  emptyForm,
  FORM_SCOPES,
  newLimiter,
  TIMELOCK_HOURS,
  toConfigArgs,
  toLimiterArgs,
  validate,
  type FormErrors,
  type LimiterForm,
  type RegisterForm,
} from "./form-model";

type Step = "details" | "review" | "register";

const scopeName = (n: number) =>
  n in TEST_VAULT_SCOPE_LABELS
    ? `Scope ${n} (${TEST_VAULT_SCOPE_LABELS[n].toLowerCase()})`
    : `Scope ${n}`;

/**
 * Register a protocol behind the gate: initialize_config, then one
 * init_flow_limiter per token. Details, then a review, then each transaction
 * in turn.
 */
export function RegisterFlow() {
  const wallet = useConnectedWallet();
  const [form, setForm] = useState<RegisterForm>(emptyForm);
  const [step, setStep] = useState<Step>("details");
  const [showErrors, setShowErrors] = useState(false);
  const errors = validate(form);
  const errorCount = Object.keys(errors).length;

  if (!wallet) {
    return (
      <Panel title="Connect a wallet to register">
        <p className="text-body text-ink-secondary">
          The wallet that registers a protocol must be the protected
          program&apos;s upgrade authority. The admin can be that wallet or
          another address, such as a Squads multisig.
        </p>
      </Panel>
    );
  }

  if (step === "review") {
    return (
      <Review
        form={form}
        wallet={wallet}
        onBack={() => setStep("details")}
        onConfirm={() => setStep("register")}
      />
    );
  }

  if (step === "register") {
    return (
      <Submit
        form={form}
        wallet={wallet}
        onEdit={() => setStep("details")}
        onRestart={() => {
          setForm(emptyForm());
          setShowErrors(false);
          setStep("details");
        }}
      />
    );
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (errorCount > 0) setShowErrors(true);
        else setStep("review");
      }}
      className="flex flex-col gap-6"
    >
      <Details
        form={form}
        setForm={setForm}
        errors={showErrors ? errors : {}}
        wallet={wallet}
      />
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="primary">
          Review
        </Button>
        {showErrors && errorCount > 0 && (
          <p role="alert" className="flex items-center gap-2 text-body">
            <CircleAlert aria-hidden className="size-4 text-tripped" />
            {errorCount === 1
              ? "One field needs fixing above."
              : `${errorCount} fields need fixing above.`}
          </p>
        )}
      </div>
    </form>
  );
}

// Details --------------------------------------------------------------------------

function Details({
  form,
  setForm,
  errors,
  wallet,
}: {
  form: RegisterForm;
  setForm: (update: (f: RegisterForm) => RegisterForm) => void;
  errors: FormErrors;
  wallet: string;
}) {
  const mock = useMockControls();
  const [creating, setCreating] = useState(false);
  const set = (patch: Partial<RegisterForm>) =>
    setForm((f) => ({ ...f, ...patch }));
  const setLimiter = (id: number, patch: Partial<LimiterForm>) =>
    setForm((f) => ({
      ...f,
      limiters: f.limiters.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));

  const fillDemoProgram = async () => {
    if (!mock) return;
    setCreating(true);
    try {
      const demo = await mock.createDemoProgram();
      setForm((f) => ({
        ...f,
        program: demo.program,
        limiters: f.limiters.map((l, i) =>
          i === 0 ? { ...l, mint: demo.mint, vault: demo.vault } : l,
        ),
      }));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <Panel
        title="Protocol"
        description="The program to put behind the gate. Its withdrawals will ask Breakglass first."
        actions={
          mock && (
            <Button
              icon={<Sparkles aria-hidden className="size-4" />}
              pending={creating}
              onClick={fillDemoProgram}
            >
              Use a new demo program
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Program address"
            value={form.program}
            onChange={(e) => set({ program: e.target.value })}
            placeholder="2orgNn8kfHVQi8EMxa86zntq8BbwQefXPtpZiQTfgPyn"
            spellCheck={false}
            autoComplete="off"
            error={errors.program}
            hint={
              mock
                ? "In the demo, a new demo program is one your wallet deployed."
                : "Your wallet must be this program's upgrade authority."
            }
          />
          <Input
            label="Admin"
            value={form.admin}
            onChange={(e) => set({ admin: e.target.value })}
            placeholder={`${shortAddress(wallet)} (your wallet)`}
            spellCheck={false}
            autoComplete="off"
            error={errors.admin}
            hint="Proposes changes, lifts pauses and rejects holds. Leave empty for your wallet, or enter another address such as a Squads multisig vault."
          />
        </div>
      </Panel>

      <Panel
        title="Guardians"
        description="Independent parties who can pause, freeze holds and veto changes, but never move funds. Up to 5."
      >
        <div className="flex flex-col gap-3">
          {form.guardians.map((g, i) => (
            <div key={i} className="flex items-start gap-2">
              <Input
                label={`Guardian ${i + 1}`}
                value={g}
                onChange={(e) =>
                  set({
                    guardians: form.guardians.map((x, j) =>
                      j === i ? e.target.value : x,
                    ),
                  })
                }
                spellCheck={false}
                autoComplete="off"
                error={errors[`guardians.${i}`]}
                className="flex-1"
              />
              {form.guardians.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove guardian ${i + 1}`}
                  onClick={() =>
                    set({ guardians: form.guardians.filter((_, j) => j !== i) })
                  }
                  className="mt-9 rounded-control p-2.5 text-ink-secondary hover:bg-surface-inset hover:text-ink"
                >
                  <Trash2 aria-hidden className="size-4" />
                </button>
              )}
            </div>
          ))}
          {errors.guardians && <p className="text-body">{errors.guardians}</p>}
          <div className="flex flex-wrap gap-2">
            {form.guardians.length < 5 && (
              <Button
                variant="quiet"
                icon={<Plus aria-hidden className="size-4" />}
                onClick={() => set({ guardians: [...form.guardians, ""] })}
              >
                Add a guardian
              </Button>
            )}
            {mock &&
              !form.guardians.includes(MOCK_WALLETS.guardian.address) && (
                <Button
                  variant="quiet"
                  onClick={() =>
                    set({
                      guardians: [
                        ...form.guardians.filter(Boolean),
                        MOCK_WALLETS.guardian.address,
                      ],
                    })
                  }
                >
                  Add the demo guardian
                </Button>
              )}
          </div>
        </div>
      </Panel>

      <Panel
        title="Safety settings"
        description="These loosen protection, so changing them later waits out the timelock."
      >
        <div className="flex flex-col gap-6">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-title2 font-medium">
              Scopes that are always open
            </legend>
            <p className="text-body text-ink-muted">
              Nobody can ever pause these, not even the admin. Use it for exits
              such as repaying a loan.
            </p>
            <div className="flex flex-wrap gap-2">
              {FORM_SCOPES.map((n) => {
                const on = form.unpausable.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      set({
                        unpausable: on
                          ? form.unpausable.filter((s) => s !== n)
                          : [...form.unpausable, n].sort((a, b) => a - b),
                      })
                    }
                    className={cx(
                      "inline-flex h-9 items-center gap-1.5 rounded-control border px-3 text-body",
                      on
                        ? "border-primary bg-primary text-on-primary"
                        : "border-line-strong bg-surface text-ink hover:bg-surface-inset",
                    )}
                  >
                    {on && <Check aria-hidden className="size-4" />}
                    {scopeName(n)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <Input
            label="Timelock"
            value={form.timelockHours}
            onChange={(e) => set({ timelockHours: e.target.value })}
            inputMode="decimal"
            suffix="hours"
            error={errors.timelockHours}
            hint={`How long loosening changes wait, so the guardian can veto them. ${TIMELOCK_HOURS.min} to ${TIMELOCK_HOURS.max} hours.`}
            className="max-w-xs"
          />
        </div>
      </Panel>

      <Panel
        title="Withdrawal limits"
        description="One limiter per token. It caps outflow per window, holds large withdrawals, and pauses the scope by itself when the cap is hit."
      >
        <div className="flex flex-col gap-4">
          {form.limiters.map((l, i) => (
            <LimiterFields
              key={l.id}
              limiter={l}
              index={i}
              errors={errors}
              unpausable={form.unpausable}
              onChange={(patch) => setLimiter(l.id, patch)}
              onRemove={
                form.limiters.length > 1
                  ? () =>
                      set({
                        limiters: form.limiters.filter((x) => x.id !== l.id),
                      })
                  : undefined
              }
            />
          ))}
          {errors.limiters && <p className="text-body">{errors.limiters}</p>}
          <div>
            <Button
              variant="quiet"
              icon={<Plus aria-hidden className="size-4" />}
              onClick={() =>
                set({
                  limiters: [
                    ...form.limiters,
                    {
                      ...newLimiter(
                        Math.max(...form.limiters.map((x) => x.id), 0) + 1,
                      ),
                      symbol: "",
                    },
                  ],
                })
              }
            >
              Add a token
            </Button>
          </div>
        </div>
      </Panel>
    </>
  );
}

function LimiterFields({
  limiter: l,
  index,
  errors,
  unpausable,
  onChange,
  onRemove,
}: {
  limiter: LimiterForm;
  index: number;
  errors: FormErrors;
  unpausable: number[];
  onChange: (patch: Partial<LimiterForm>) => void;
  onRemove?: () => void;
}) {
  const at = (f: string) => errors[`limiters.${index}.${f}`];
  const unit = l.symbol.trim() || "tokens";
  return (
    <InsetPanel className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-title1 font-medium">
          {l.symbol.trim() || `Token ${index + 1}`}
        </h3>
        {onRemove && (
          <Button
            variant="quiet"
            icon={<Trash2 aria-hidden className="size-4" />}
            onClick={onRemove}
          >
            Remove
          </Button>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Token name"
          value={l.symbol}
          onChange={(e) => onChange({ symbol: e.target.value })}
          hint="For people only, such as USDC."
        />
        <Input
          label="Decimals"
          value={l.decimals}
          onChange={(e) => onChange({ decimals: e.target.value })}
          inputMode="numeric"
          error={at("decimals")}
        />
        <Input
          label="Mint address"
          value={l.mint}
          onChange={(e) => onChange({ mint: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          error={at("mint")}
        />
        <Input
          label="Vault token account"
          value={l.vault}
          onChange={(e) => onChange({ vault: e.target.value })}
          spellCheck={false}
          autoComplete="off"
          error={at("vault")}
          hint="Where the protocol keeps this token."
        />
        <Select
          label="Scope it gates"
          value={l.scope}
          onChange={(e) => onChange({ scope: e.target.value })}
          options={FORM_SCOPES.map((n) => ({
            value: String(n),
            label: unpausable.includes(n)
              ? `${scopeName(n)}, always open`
              : scopeName(n),
          }))}
          error={at("scope")}
          hint="Paused by itself when the cap is hit."
        />
        <Input
          label="Window"
          value={l.windowMinutes}
          onChange={(e) => onChange({ windowMinutes: e.target.value })}
          inputMode="decimal"
          suffix="minutes"
          error={at("windowMinutes")}
          hint="The rolling period the cap counts over."
        />
        <Input
          label="Cap per window"
          value={l.cap}
          onChange={(e) => onChange({ cap: e.target.value })}
          inputMode="decimal"
          suffix={unit}
          error={at("cap")}
        />
        <Input
          label="Or a share of the vault"
          value={l.capPercent}
          onChange={(e) => onChange({ capPercent: e.target.value })}
          inputMode="decimal"
          suffix="%"
          error={at("capPercent")}
          hint="The smaller of the two applies. Leave empty for none."
        />
        <Input
          label="Hold withdrawals from"
          value={l.threshold}
          onChange={(e) => onChange({ threshold: e.target.value })}
          inputMode="decimal"
          suffix={unit}
          error={at("threshold")}
        />
        <Input
          label="Or a share of the vault"
          value={l.thresholdPercent}
          onChange={(e) => onChange({ thresholdPercent: e.target.value })}
          inputMode="decimal"
          suffix="%"
          error={at("thresholdPercent")}
          hint="The smaller of the two applies. Leave empty for none."
        />
        <Input
          label="Hold for"
          value={l.holdHours}
          onChange={(e) => onChange({ holdHours: e.target.value })}
          inputMode="decimal"
          suffix="hours"
          error={at("holdHours")}
        />
      </div>
      <label className="flex items-start gap-3 text-body">
        <input
          type="checkbox"
          checked={l.screenAll}
          onChange={(e) => onChange({ screenAll: e.target.checked })}
          className="mt-1 size-4 accent-primary"
        />
        <span>
          <span className="font-medium">Screen every withdrawal</span>
          <span className="block text-ink-muted">
            Zero-loss mode: every withdrawal waits about two minutes so the
            guardian can stop a bad one.
          </span>
        </span>
      </label>
    </InsetPanel>
  );
}

// Review -----------------------------------------------------------------------------

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-3 last:border-b-0 sm:grid-cols-[14rem_1fr]">
      <dt className="text-ink-secondary">{label}</dt>
      <dd className="break-all">{children}</dd>
    </div>
  );
}

/** A typed amount, tidied for reading back ("20000" becomes "20,000"). */
function tidy(text: string, decimals: string): string {
  const d = Number(decimals);
  const units = parseUnits(text, d);
  return units === null ? text : formatUnits(units, d);
}

function limiterSummary(l: LimiterForm): string {
  const unit = l.symbol.trim() || "tokens";
  const capAmount = `${tidy(l.cap, l.decimals)} ${unit}`;
  const holdAmount = `${tidy(l.threshold, l.decimals)} ${unit}`;
  const cap = l.capPercent.trim()
    ? `${capAmount} or ${l.capPercent}% of the vault, whichever is smaller`
    : capAmount;
  const hold = l.thresholdPercent.trim()
    ? `${holdAmount} or ${l.thresholdPercent}% of the vault`
    : holdAmount;
  return `Up to ${cap} every ${l.windowMinutes} minutes. Withdrawals from ${hold} wait ${l.holdHours} hours.${l.screenAll ? " Every withdrawal is screened first." : ""}`;
}

function Review({
  form,
  wallet,
  onBack,
  onConfirm,
}: {
  form: RegisterForm;
  wallet: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const guardians = form.guardians.filter((g) => g.trim());
  const admin = adminOf(form, wallet);
  return (
    <div className="flex flex-col gap-6">
      <Panel
        title="Review"
        description="Check what will be set. Loosening any of it later waits out the timelock."
      >
        <dl className="text-body">
          <Row label="Protocol">{form.program}</Row>
          <Row label="Admin">
            {admin}
            {admin === wallet ? " (your wallet)" : ""}
          </Row>
          <Row label="Guardians">
            {guardians.map((g) => (
              <span key={g} className="block">
                {g}
              </span>
            ))}
          </Row>
          <Row label="Always open">
            {form.unpausable.length
              ? form.unpausable.map(scopeName).join(", ")
              : "None"}
          </Row>
          <Row label="Timelock">{form.timelockHours} hours</Row>
          {form.limiters.map((l, i) => (
            <Row
              key={l.id}
              label={`Limit: ${l.symbol.trim() || `Token ${i + 1}`}`}
            >
              {limiterSummary(l)} Gates{" "}
              {scopeName(Number(l.scope)).toLowerCase()}.
            </Row>
          ))}
        </dl>
      </Panel>
      <Panel
        title="What you'll sign"
        description={
          admin === wallet
            ? `${1 + form.limiters.length} transactions, one after the other.`
            : "One transaction. The token limits are the admin's to set up."
        }
      >
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-body">
          <li>Register the protocol and its guardians.</li>
          {admin === wallet &&
            form.limiters.map((l, i) => (
              <li key={l.id}>
                Set up the {l.symbol.trim() || `token ${i + 1}`} limiter.
              </li>
            ))}
        </ol>
        {admin !== wallet && (
          <p className="mt-3 text-body text-ink-secondary">
            Only the admin can set up a limiter, so {shortAddress(admin)} signs
            those itself after registration, with the settings above.
          </p>
        )}
      </Panel>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="quiet"
          icon={<ArrowLeft aria-hidden className="size-4" />}
          onClick={onBack}
        >
          Edit details
        </Button>
        <Button variant="primary" onClick={onConfirm}>
          Register protocol
        </Button>
      </div>
    </div>
  );
}

// Register ---------------------------------------------------------------------------

type TxState =
  | { state: "waiting" }
  | { state: "sending" }
  | { state: "done"; signature: string }
  | { state: "failed"; message: string };

/** Plain words for the failures this flow can hit (5.4 covers the rest). */
function explain(error: unknown, isLimiter: boolean): string {
  if (!isClientError(error)) return "Something went wrong. Try again.";
  switch (error.errorName) {
    case "Unauthorized":
      return isLimiter
        ? "Only the admin can set up a limiter."
        : "Your wallet must be the program's upgrade authority.";
    case "AccountAlreadyInUse":
      return isLimiter
        ? "This token already has a limiter."
        : "This program is already registered.";
    case "InvalidTimelock":
      return `The timelock must be ${TIMELOCK_HOURS.min} to ${TIMELOCK_HOURS.max} hours.`;
    case "TooManyGuardians":
      return "Up to 5 guardians.";
    case "ScopeUnpausable":
      return "A limiter can't gate a scope that is always open.";
    case "InvalidLimiterConfig":
      return "Some limiter settings are out of range.";
    case "WalletNotConnected":
      return "Connect a wallet first.";
    default:
      return error.message;
  }
}

function Submit({
  form,
  wallet,
  onEdit,
  onRestart,
}: {
  form: RegisterForm;
  wallet: string;
  onEdit: () => void;
  onRestart: () => void;
}) {
  const toast = useToast();
  // Only the admin can set up limiters; another admin signs them itself.
  const selfAdmin = adminOf(form, wallet) === wallet;
  const labels = [
    "Register the protocol",
    ...(selfAdmin ? form.limiters : []).map(
      (l, i) => `Set up the ${l.symbol.trim() || `token ${i + 1}`} limiter`,
    ),
  ];
  const [states, setStates] = useState<TxState[]>(() =>
    labels.map(() => ({ state: "waiting" })),
  );
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [config, setConfig] = useState<string | null>(null);

  const setAt = (i: number, s: TxState) =>
    setStates((all) => all.map((x, j) => (j === i ? s : x)));

  const run = async () => {
    setStarted(true);
    setRunning(true);
    const client = getBreakglassClient();
    let configAddress = config;
    for (let i = 0; i < labels.length; i++) {
      if (states[i].state === "done") continue;
      setAt(i, { state: "sending" });
      try {
        let signature: string;
        if (i === 0) {
          signature = (
            await client.initializeConfig(toConfigArgs(form, wallet))
          ).signature;
          configAddress =
            (await client.getConfig(form.program.trim()))?.address ?? null;
          setConfig(configAddress);
        } else {
          if (!configAddress)
            throw new Error("The protocol isn't registered yet.");
          signature = (
            await client.initFlowLimiter(
              toLimiterArgs(form.limiters[i - 1], configAddress),
            )
          ).signature;
        }
        setAt(i, { state: "done", signature });
      } catch (error) {
        setAt(i, { state: "failed", message: explain(error, i > 0) });
        setRunning(false);
        return;
      }
    }
    setRunning(false);
    toast.show({ tone: "open", title: "Protocol registered" });
  };

  const allDone = states.every((s) => s.state === "done");
  const failed = states.some((s) => s.state === "failed");

  return (
    <div className="flex flex-col gap-6">
      <Panel
        title={allDone ? "Protocol registered" : "Register"}
        description={
          allDone
            ? `${shortAddress(form.program.trim())} is behind the gate. Its withdrawals now ask Breakglass first.`
            : "Each transaction asks your wallet to sign, one after the other."
        }
      >
        <ol className="flex flex-col divide-y divide-line">
          {labels.map((label, i) => (
            <TxRow key={label} index={i} label={label} tx={states[i]} />
          ))}
        </ol>
      </Panel>
      <div className="flex flex-wrap gap-3">
        {!started && (
          <>
            <Button
              variant="quiet"
              icon={<ArrowLeft aria-hidden className="size-4" />}
              onClick={onEdit}
            >
              Edit details
            </Button>
            <Button variant="primary" onClick={run}>
              Sign and send
            </Button>
          </>
        )}
        {failed && !running && (
          <>
            {!config && (
              <Button
                variant="quiet"
                icon={<ArrowLeft aria-hidden className="size-4" />}
                onClick={onEdit}
              >
                Edit details
              </Button>
            )}
            <Button variant="primary" onClick={run}>
              Try again
            </Button>
          </>
        )}
        {allDone && (
          <>
            <Link
              href="/dashboard"
              className="inline-flex h-11 items-center rounded-control bg-primary px-4 font-label text-body font-semibold text-on-primary hover:bg-primary-hover"
            >
              Open the overview
            </Link>
            <Button onClick={onRestart}>Register another</Button>
          </>
        )}
      </div>
    </div>
  );
}

function TxRow({
  index,
  label,
  tx,
}: {
  index: number;
  label: string;
  tx: TxState;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <span className="flex items-center gap-3 text-body">
        <span className="font-label text-caption font-semibold text-ink-muted">
          {index + 1}
        </span>
        {label}
      </span>
      <span className="flex items-center gap-2 text-body">
        {tx.state === "waiting" && (
          <span className="text-ink-muted">Waiting</span>
        )}
        {tx.state === "sending" && (
          <>
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
            Sending
          </>
        )}
        {tx.state === "done" && (
          <Badge status="open" title={tx.signature}>
            Confirmed
          </Badge>
        )}
        {tx.state === "failed" && (
          <span className="flex items-center gap-2" role="alert">
            <CircleAlert aria-hidden className="size-4 shrink-0 text-tripped" />
            {tx.message}
          </span>
        )}
      </span>
    </li>
  );
}
