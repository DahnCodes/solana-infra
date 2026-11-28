"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleCheck,
  CircleX,
  Clock,
} from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Amount } from "@/components/amount";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Countdown } from "@/components/countdown";
import { Input } from "@/components/input";
import { InsetPanel, Panel } from "@/components/panel";
import { useToast } from "@/components/toast";
import {
  useChainNow,
  useConnectedWallet,
  useFlowLimiters,
  useHolds,
  useMockControls,
  usePauseState,
  usePosition,
  useProtocol,
  useTestVault,
  useTokenBalance,
} from "@/hooks/use-breakglass";
import { useWrite } from "@/hooks/use-write";
import type {
  AccountRecord,
  Address,
  ClientError,
  FlowLimiter,
  PendingWithdrawal,
  WithdrawResult,
} from "@/lib/breakglass";
import { formatSpan, scopeLabel } from "@/lib/breakglass/describe";
import { isClientError } from "@/lib/breakglass/errors";
import { walletTokenAccount } from "@/lib/breakglass/mock/engine";
import { effectiveThreshold } from "@/lib/breakglass/rules/limiter";
import { runningPauses } from "@/lib/breakglass/rules/pauses";
import {
  predictWithdrawal,
  type Prediction,
} from "@/lib/breakglass/rules/predict";
import { formatDateTime, formatUnits, parseUnits } from "@/lib/format";
import { tokenInfo } from "@/lib/tokens";

/** Plain words for the failures these forms can hit (5.4 covers the rest). */
function explain(error: unknown): string {
  if (!isClientError(error)) return "Something went wrong. Try again.";
  const e = error as ClientError;
  switch (e.errorName) {
    case "ScopePaused":
      return "This action is paused for safety right now.";
    case "InsufficientPosition":
      return "That's more than you can withdraw.";
    case "InsufficientFunds":
      return "That's more than your wallet holds.";
    case "WalletNotConnected":
      return "Connect a wallet first.";
    default:
      return e.message;
  }
}

/** Deposit into and withdraw from the test vault, through the gate. */
export function VaultForms() {
  const wallet = useConnectedWallet();
  const vault = useTestVault();
  const protocol = useProtocol();
  const now = useChainNow();
  const config = protocol.data?.address ?? null;
  const limiters = useFlowLimiters(config);
  const limiter = limiters.data?.find((l) => l.account.mint === vault?.mint);

  if (!vault || protocol.loading || limiters.loading || now === null) {
    return <p className="text-body text-ink-muted">Loading the vault…</p>;
  }
  if (!wallet) {
    return (
      <Panel title="Connect a wallet">
        <p className="text-body text-ink-secondary">
          Connect a wallet to deposit and withdraw.
        </p>
      </Panel>
    );
  }
  if (!config || !limiter) {
    return (
      <Panel title="The vault isn't behind the gate">
        <p className="text-body text-ink-secondary">
          Its withdrawals have no limiter yet.
        </p>
      </Panel>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Position wallet={wallet} vault={vault.vault} mint={vault.mint} />
      <WithdrawForm
        wallet={wallet}
        vault={vault.vault}
        config={config}
        limiter={limiter.account}
        now={now}
      />
      <DepositForm wallet={wallet} vault={vault.vault} mint={vault.mint} />
      <YourHolds wallet={wallet} config={config} now={now} />
    </div>
  );
}

/** The token symbol and a Max button, inside an amount field. */
function MaxSuffix({ symbol, onMax }: { symbol: string; onMax: () => void }) {
  return (
    <span className="flex items-center gap-2">
      {symbol}
      <button
        type="button"
        onClick={onMax}
        className="rounded-control border border-line-strong px-2 py-0.5 font-label text-caption font-semibold text-ink hover:bg-surface-inset"
      >
        Max
      </button>
    </span>
  );
}

// Position -----------------------------------------------------------------------

function Position({
  wallet,
  vault,
  mint,
}: {
  wallet: Address;
  vault: Address;
  mint: Address;
}) {
  const position = usePosition(vault, wallet);
  const balance = useTokenBalance(walletTokenAccount(wallet, mint));
  const token = tokenInfo(mint);
  const amount = (v: bigint | undefined) =>
    v === undefined ? (
      <span className="text-ink-muted">…</span>
    ) : (
      <Amount value={v} decimals={token.decimals} symbol={token.symbol} />
    );
  return (
    <Panel
      title="Your position"
      description="What you have in the test vault, and in your wallet."
      className="lg:col-span-2"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Figure label="Can withdraw">
          {position.loading
            ? amount(undefined)
            : amount(position.data?.amount ?? BigInt(0))}
        </Figure>
        <Figure label="Held, still yours">
          {position.loading
            ? amount(undefined)
            : amount(position.data?.held ?? BigInt(0))}
        </Figure>
        <Figure label="In your wallet">{amount(balance.data)}</Figure>
      </div>
    </Panel>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <InsetPanel className="flex flex-col gap-1">
      <span className="font-label text-caption font-semibold text-ink-muted uppercase">
        {label}
      </span>
      <span className="text-title1">{children}</span>
    </InsetPanel>
  );
}

// Withdraw -----------------------------------------------------------------------

function WithdrawForm({
  wallet,
  vault,
  config,
  limiter,
  now,
}: {
  wallet: Address;
  vault: Address;
  config: Address;
  limiter: FlowLimiter;
  now: number;
}) {
  const toast = useToast();
  const token = tokenInfo(limiter.mint);
  const position = usePosition(vault, wallet);
  const pauses = usePauseState(config);
  const vaultBalance = useTokenBalance(limiter.vault);
  const [text, setText] = useState("");
  const [result, setResult] = useState<WithdrawResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const amount = parseUnits(text, token.decimals);
  const available = position.data?.amount ?? BigInt(0);
  const problem =
    text.trim() === ""
      ? null
      : amount === null || amount === BigInt(0)
        ? "Enter an amount above zero."
        : amount > available
          ? "That's more than you can withdraw."
          : null;

  const prediction =
    amount && !problem && vaultBalance.data !== undefined
      ? predictWithdrawal(
          limiter,
          vaultBalance.data,
          runningPauses(pauses.data?.account.active ?? [], now),
          amount,
          now,
        )
      : null;

  const withdraw = useWrite((c) =>
    c.withdraw({ vault, amount: amount ?? BigInt(0) }),
  );

  const send = async () => {
    setFailure(null);
    setResult(null);
    try {
      const r = await withdraw.run();
      setResult(r);
      setText("");
      toast.show(
        r.decision === "allow"
          ? { tone: "open", title: "Withdrawal sent" }
          : {
              tone: "held",
              title: "Withdrawal held",
              description: `Claimable ${formatDateTime(r.releaseAt)}.`,
            },
      );
    } catch (error) {
      const message = explain(error);
      setFailure(message);
      toast.show({
        tone: "tripped",
        title: "Withdrawal denied",
        description: message,
      });
    }
  };

  return (
    <Panel title="Withdraw" description="Every withdrawal asks the gate first.">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (amount && !problem) void send();
        }}
        className="flex flex-col gap-4"
      >
        <Input
          label="Amount"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
            setFailure(null);
          }}
          inputMode="decimal"
          placeholder="1,000"
          suffix={
            <MaxSuffix
              symbol={token.symbol}
              onMax={() => setText(formatUnits(available, token.decimals))}
            />
          }
          error={problem ?? undefined}
        />
        {prediction && (
          <PredictionLine
            prediction={prediction}
            limiter={limiter}
            vaultBalance={vaultBalance.data}
            now={now}
          />
        )}
        <div>
          <Button
            type="submit"
            variant="primary"
            icon={<ArrowUpFromLine aria-hidden className="size-4" />}
            pending={withdraw.pending}
            disabled={!amount || problem !== null}
          >
            Withdraw
          </Button>
        </div>
        {result && (
          <ResultCard
            result={result}
            symbol={token.symbol}
            decimals={token.decimals}
            now={now}
          />
        )}
        {failure && (
          <InsetPanel className="flex items-start gap-3" role="alert">
            <CircleX
              aria-hidden
              className="mt-0.5 size-5 shrink-0 text-tripped"
            />
            <div className="flex flex-col gap-1 text-body">
              <span className="font-medium">Denied</span>
              <span className="text-ink-secondary">
                {failure} Nothing left the vault.
              </span>
            </div>
          </InsetPanel>
        )}
      </form>
    </Panel>
  );
}

/** The gate's answer before sending, from the program's own rules. */
function PredictionLine({
  prediction,
  limiter,
  vaultBalance,
  now,
}: {
  prediction: Prediction;
  limiter: FlowLimiter;
  vaultBalance: bigint | undefined;
  now: number;
}) {
  const token = tokenInfo(limiter.mint);
  const threshold =
    vaultBalance !== undefined
      ? `${formatUnits(effectiveThreshold(limiter, vaultBalance), token.decimals)} ${token.symbol}`
      : "the threshold";
  const line = (() => {
    switch (prediction.kind) {
      case "allow":
        return {
          icon: <CircleCheck aria-hidden className="size-4 text-open" />,
          text: "The gate will send this at once.",
        };
      case "holdLarge":
        return {
          icon: <Clock aria-hidden className="size-4 text-held" />,
          text: `The gate will hold this for ${formatSpan(prediction.holdSecs)}: withdrawals from ${threshold} wait in public first.`,
        };
      case "holdScreen":
        return {
          icon: <Clock aria-hidden className="size-4 text-held" />,
          text: `The gate will screen this for ${formatSpan(prediction.holdSecs)} before it can be claimed.`,
        };
      case "holdBreach":
        return {
          icon: <Clock aria-hidden className="size-4 text-held" />,
          text: `This would cross the window's cap: it will be held for ${formatSpan(prediction.holdSecs)}, and ${scopeLabel(limiter.scope).toLowerCase()} pause for ${formatSpan(prediction.tripSecs)}.`,
        };
      case "deny":
        return {
          icon: <CircleX aria-hidden className="size-4 text-tripped" />,
          text: `${scopeLabel(limiter.scope)} are paused for ${formatSpan(prediction.pausedUntil - now)} more. This won't go through.`,
        };
    }
  })();
  return (
    <p
      className="flex items-start gap-2 text-body text-ink-secondary"
      aria-live="polite"
    >
      <span className="mt-0.5 shrink-0">{line.icon}</span>
      {line.text}
    </p>
  );
}

/** What the gate did with the last withdrawal. */
function ResultCard({
  result,
  symbol,
  decimals,
  now,
}: {
  result: WithdrawResult;
  symbol: string;
  decimals: number;
  now: number;
}) {
  const amount = result.events.find(
    (e) =>
      e.name === "outflowRecorded" ||
      e.name === "largeWithdrawalQueued" ||
      e.name === "limitHoldQueued" ||
      e.name === "withdrawalScreenQueued",
  );
  const value =
    amount && "amount" in amount.data ? (amount.data.amount as bigint) : null;
  const tripped = result.events.some((e) => e.name === "limitTripped");

  if (result.decision === "allow") {
    return (
      <InsetPanel className="flex items-start gap-3" role="status">
        <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-open" />
        <div className="flex flex-col gap-1 text-body">
          <span className="font-medium">
            Sent
            {value !== null && (
              <>
                : <Amount value={value} decimals={decimals} symbol={symbol} />
              </>
            )}
          </span>
          <span className="text-ink-secondary">
            It&apos;s in your wallet now.
          </span>
        </div>
      </InsetPanel>
    );
  }
  return (
    <InsetPanel className="flex items-start gap-3" role="status">
      <Clock aria-hidden className="mt-0.5 size-5 shrink-0 text-held" />
      <div className="flex flex-col gap-1 text-body">
        <span className="font-medium">
          Held
          {value !== null && (
            <>
              : <Amount value={value} decimals={decimals} symbol={symbol} />
            </>
          )}
        </span>
        <span className="text-ink-secondary">
          You can claim it {formatDateTime(result.releaseAt)}, in{" "}
          <Countdown target={result.releaseAt} now={now} doneLabel="now" />.
          {tripped && " It crossed the cap, so withdrawals are paused for now."}{" "}
          It stays yours meanwhile.
        </span>
        <Link
          href="/holds"
          className="self-start text-ink underline underline-offset-4"
        >
          See held withdrawals
        </Link>
      </div>
    </InsetPanel>
  );
}

// Deposit ------------------------------------------------------------------------

function DepositForm({
  wallet,
  vault,
  mint,
}: {
  wallet: Address;
  vault: Address;
  mint: Address;
}) {
  const toast = useToast();
  const mock = useMockControls();
  const token = tokenInfo(mint);
  const balance = useTokenBalance(walletTokenAccount(wallet, mint));
  const [text, setText] = useState("");
  const [funding, setFunding] = useState(false);
  const amount = parseUnits(text, token.decimals);
  const inWallet = balance.data ?? BigInt(0);
  const problem =
    text.trim() === ""
      ? null
      : amount === null || amount === BigInt(0)
        ? "Enter an amount above zero."
        : amount > inWallet
          ? "That's more than your wallet holds."
          : null;
  const deposit = useWrite((c) =>
    c.deposit({ vault, amount: amount ?? BigInt(0) }),
  );

  return (
    <Panel
      title="Deposit"
      description="Deposits don't pass the limiter; only the deposit pause can stop them."
    >
      <form
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!amount || problem) return;
          try {
            await deposit.run();
            setText("");
            toast.show({ tone: "open", title: "Deposit made" });
          } catch (error) {
            toast.show({
              tone: "tripped",
              title: "Deposit failed",
              description: explain(error),
            });
          }
        }}
        className="flex flex-col gap-4"
      >
        <Input
          label="Amount"
          value={text}
          onChange={(e) => setText(e.target.value)}
          inputMode="decimal"
          placeholder="1,000"
          suffix={
            <MaxSuffix
              symbol={token.symbol}
              onMax={() => setText(formatUnits(inWallet, token.decimals))}
            />
          }
          error={problem ?? undefined}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            icon={<ArrowDownToLine aria-hidden className="size-4" />}
            pending={deposit.pending}
            disabled={!amount || problem !== null}
          >
            Deposit
          </Button>
          {mock && inWallet === BigInt(0) && balance.data !== undefined && (
            <Button
              variant="quiet"
              pending={funding}
              onClick={async () => {
                setFunding(true);
                try {
                  await mock.requestTestTokens(
                    BigInt(10_000) * BigInt(10 ** token.decimals),
                  );
                } finally {
                  setFunding(false);
                }
              }}
            >
              Get 10,000 test {token.symbol}
            </Button>
          )}
        </div>
      </form>
    </Panel>
  );
}

// Your holds ---------------------------------------------------------------------

function YourHolds({
  wallet,
  config,
  now,
}: {
  wallet: Address;
  config: Address;
  now: number;
}) {
  const holds = useHolds(config, { owner: wallet });
  const open = (holds.data ?? []).filter(
    (h) =>
      h.account.status === "queued" ||
      h.account.status === "frozen" ||
      h.account.status === "released",
  );
  return (
    <Panel
      title="Your held withdrawals"
      description="Claim each one once its hold ends."
    >
      {holds.loading ? (
        <p className="text-body text-ink-muted">Loading…</p>
      ) : open.length === 0 ? (
        <p className="text-body text-ink-secondary">You have nothing held.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {open.map((h) => (
            <HoldRow key={h.address} config={config} hold={h} now={now} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function HoldRow({
  config,
  hold,
  now,
}: {
  config: Address;
  hold: AccountRecord<PendingWithdrawal>;
  now: number;
}) {
  const toast = useToast();
  const h = hold.account;
  const token = tokenInfo(h.mint);
  const claim = useWrite((c) => c.claimHeld({ config, hold: hold.address }));
  const claimable =
    h.status === "released" || (h.status === "queued" && now >= h.releaseAt);

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-body">
      <span className="flex flex-col gap-1">
        <Amount
          value={h.amount}
          decimals={token.decimals}
          symbol={token.symbol}
        />
        <span className="flex items-center gap-2 text-ink-secondary">
          {h.status === "frozen" ? (
            <Badge status="tripped">Frozen by the guardian</Badge>
          ) : claimable ? (
            <Badge status="open">Ready to claim</Badge>
          ) : (
            <>
              <Badge status="held">Held</Badge>
              <Countdown target={h.releaseAt} now={now} />
            </>
          )}
        </span>
      </span>
      {claimable && (
        <Button
          pending={claim.pending}
          onClick={async () => {
            try {
              const r = await claim.run();
              toast.show(
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
                        "Claiming it now would cross the window's cap, so withdrawals paused. Try again once the window frees up and they reopen.",
                    },
              );
            } catch (error) {
              toast.show({
                tone: "tripped",
                title: "Claim failed",
                description: explain(error),
              });
            }
          }}
        >
          Claim
        </Button>
      )}
    </li>
  );
}
