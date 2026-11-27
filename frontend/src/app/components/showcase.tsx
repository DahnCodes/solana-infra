"use client";

import { ShieldAlert, Snowflake } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Amount } from "@/components/amount";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Countdown } from "@/components/countdown";
import { Dialog } from "@/components/dialog";
import { Input } from "@/components/input";
import { InsetPanel, Panel } from "@/components/panel";
import { ToastCard, ToastProvider, useToast } from "@/components/toast";
import { useNow } from "@/hooks/use-now";

export function Showcase() {
  return (
    <ToastProvider>
      <div className="grid gap-6 xl:grid-cols-2">
        <ThemeColumn theme="light" />
        <ThemeColumn theme="dark" />
      </div>
    </ToastProvider>
  );
}

function ThemeColumn({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      data-theme={theme}
      className="flex min-w-0 flex-col gap-6 rounded-card border border-line bg-canvas p-4 text-ink sm:p-6"
    >
      <h2 className="text-h5 font-medium">
        {theme === "light" ? "Light" : "Dark"}
      </h2>
      <Buttons />
      <Inputs />
      <Badges />
      <PanelDemo />
      <Amounts />
      <Countdowns />
      <DialogDemo />
      <Toasts />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-card bg-surface p-6">
      <h3 className="font-label text-caption font-semibold text-ink-muted uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Buttons() {
  return (
    <Section title="Button">
      <div className="flex flex-wrap gap-3">
        <Button variant="primary">Propose change</Button>
        <Button icon={<Snowflake aria-hidden className="size-4" />}>
          Freeze hold
        </Button>
        <Button variant="quiet">Cancel</Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" pending>
          Proposing
        </Button>
        <Button disabled>Release hold</Button>
      </div>
    </Section>
  );
}

function Inputs() {
  return (
    <Section title="Input">
      <Input
        label="Amount"
        placeholder="1,000"
        inputMode="decimal"
        suffix="USDC"
        hint="Up to 61,200 USDC can leave in this window."
      />
      <Input
        label="Amount"
        defaultValue="90,000"
        inputMode="decimal"
        suffix="USDC"
        error="That's more than the 61,200 USDC left in this window."
      />
    </Section>
  );
}

function Badges() {
  return (
    <Section title="Badge">
      <div className="flex flex-wrap gap-2">
        <Badge>Admin</Badge>
        <Badge>Guardian</Badge>
        <Badge status="open">Open</Badge>
        <Badge status="held">Held</Badge>
        <Badge status="tripped">Paused</Badge>
      </div>
    </Section>
  );
}

function PanelDemo() {
  return (
    <Section title="Panel">
      <Panel
        className="border border-line"
        title="Withdrawals"
        description="Every withdrawal from the test vault passes this gate."
        actions={<Badge status="open">Open</Badge>}
      >
        <InsetPanel>
          <p className="text-body text-ink-secondary">
            Inset panel: previews, tables and details inside a card.
          </p>
        </InsetPanel>
      </Panel>
    </Section>
  );
}

function Amounts() {
  return (
    <Section title="Amount">
      <p className="text-body">
        Held: <Amount value="250000000000" decimals={6} symbol="USDC" />
      </p>
      <p className="text-body">
        Cut to 2 places:{" "}
        <Amount
          value="1234567891"
          decimals={6}
          symbol="USDC"
          maxFractionDigits={2}
        />
      </p>
      <Amount value="61200000000" decimals={6} symbol="USDC" size="card" />
      <Amount value="100000000000" decimals={6} symbol="USDC" size="hero" />
    </Section>
  );
}

function Countdowns() {
  const now = useNow();
  // Pin the targets to the first tick so they don't move while the page is open.
  const [start, setStart] = useState<number | null>(null);
  if (now !== null && start === null) setStart(now);
  const base = start ?? 0;

  return (
    <Section title="Countdown">
      <p className="text-body">
        Releases in <Countdown target={base + 47 * 60 + 9} />
      </p>
      <Countdown target={base + 26 * 3600 + 12 * 60} size="card" />
      <Countdown target={base + 47 * 3600 + 12 * 60 + 9} size="hero" />
      <Countdown target={base - 60} size="card" doneLabel="Ready to claim" />
    </Section>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <Section title="Dialog">
      <div>
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Freeze this hold?"
        description="The 250,000 USDC withdrawal stays frozen until the admin releases it through the timelock or rejects it."
        actions={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Snowflake aria-hidden className="size-4" />}
              onClick={() => setOpen(false)}
            >
              Freeze hold
            </Button>
          </>
        }
      >
        <InsetPanel className="flex items-center justify-between gap-4">
          <span className="text-body text-ink-secondary">Amount</span>
          <Amount value="250000000000" decimals={6} symbol="USDC" />
        </InsetPanel>
      </Dialog>
    </Section>
  );
}

function Toasts() {
  const toast = useToast();
  return (
    <Section title="Toast">
      <ToastCard tone="open" title="Withdrawal sent" />
      <ToastCard
        tone="held"
        title="Withdrawal held"
        description="It can be claimed after the hold ends."
      />
      <ToastCard
        tone="tripped"
        title="Withdrawal denied"
        description="Withdrawals are paused."
      />
      <div>
        <Button
          icon={<ShieldAlert aria-hidden className="size-4" />}
          onClick={() =>
            toast.show({
              tone: "held",
              title: "Hold frozen",
              description: "The guardian froze the 250,000 USDC withdrawal.",
            })
          }
        >
          Show a toast
        </Button>
      </div>
    </Section>
  );
}
