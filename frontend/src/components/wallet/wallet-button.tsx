"use client";

import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { Check, Copy, ExternalLink, LogOut, Wallet } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/button";
import { Dialog } from "@/components/dialog";
import { InsetPanel } from "@/components/panel";
import { useHydrated } from "@/hooks/use-hydrated";
import { shortAddress } from "@/lib/format";
import { clearWalletError, useWalletError } from "./wallet-errors";

/** The wallets we point people to when none is installed. */
const SUGGESTED = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/downloads" },
];

/**
 * Connect, show and disconnect the user's Solana wallet. Disconnected, it
 * opens a picker of the wallets found in the browser; connected, it shows
 * the address and opens a panel to copy it or disconnect.
 */
export function WalletButton() {
  const hydrated = useHydrated();
  const { publicKey, wallet, connecting } = useWallet();
  const [open, setOpen] = useState(false);
  const error = useWalletError();

  const close = () => {
    setOpen(false);
    clearWalletError();
  };

  // The adapter restores the last wallet from localStorage, which the server
  // can't see, so the real state only shows after hydration.
  if (!hydrated || !publicKey) {
    return (
      <>
        <Button
          variant="primary"
          icon={<Wallet aria-hidden className="size-4" />}
          pending={hydrated && connecting}
          onClick={() => setOpen(true)}
        >
          {hydrated && connecting ? "Connecting" : "Connect wallet"}
        </Button>
        {hydrated && (
          <ConnectDialog open={open} onClose={close} error={error} />
        )}
      </>
    );
  }

  const address = publicKey.toBase58();
  return (
    <>
      <Button
        icon={
          wallet ? (
            <Image
              src={wallet.adapter.icon}
              alt=""
              width={16}
              height={16}
              unoptimized
            />
          ) : (
            <Wallet aria-hidden className="size-4" />
          )
        }
        onClick={() => setOpen(true)}
        aria-label={`Wallet ${address}`}
      >
        {shortAddress(address)}
      </Button>
      <AccountDialog open={open} onClose={close} address={address} />
    </>
  );
}

function ConnectDialog({
  open,
  onClose,
  error,
}: {
  open: boolean;
  onClose: () => void;
  error: string | null;
}) {
  const { wallets, select, connecting } = useWallet();
  const found = wallets.filter(
    (w) =>
      w.readyState === WalletReadyState.Installed ||
      w.readyState === WalletReadyState.Loadable,
  );
  const missing = SUGGESTED.filter(
    (s) => !found.some((w) => w.adapter.name === s.name),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Connect a wallet"
      description="Breakglass runs on Solana devnet. Switch your wallet to devnet before you connect."
    >
      <div className="flex flex-col gap-4">
        {error && (
          <InsetPanel className="text-body">
            The wallet didn&apos;t connect: {error}
          </InsetPanel>
        )}
        {found.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {found.map((w) => (
              <li key={w.adapter.name}>
                <button
                  type="button"
                  disabled={connecting}
                  onClick={() => {
                    clearWalletError();
                    select(w.adapter.name);
                    onClose();
                  }}
                  className="flex w-full items-center gap-3 rounded-panel border border-line bg-surface px-4 py-3 text-left text-title2 font-medium hover:bg-surface-inset disabled:cursor-not-allowed"
                >
                  <Image
                    src={w.adapter.icon}
                    alt=""
                    width={28}
                    height={28}
                    unoptimized
                  />
                  <span className="flex-1">{w.adapter.name}</span>
                  <span className="font-label text-caption font-semibold text-ink-muted uppercase">
                    Detected
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-secondary">
            No Solana wallet was found in this browser. Install one, then reload
            this page.
          </p>
        )}
        {missing.length > 0 && (
          <ul className="flex flex-col gap-1">
            {missing.map((s) => (
              <li key={s.name}>
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-body text-ink-secondary underline underline-offset-4 hover:text-ink"
                >
                  Install {s.name}
                  <ExternalLink aria-hidden className="size-3.5" />
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

function AccountDialog({
  open,
  onClose,
  address,
}: {
  open: boolean;
  onClose: () => void;
  address: string;
}) {
  const { wallet, disconnect, disconnecting } = useWallet();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Your wallet"
      description={
        wallet ? `Connected with ${wallet.adapter.name}.` : undefined
      }
      actions={
        <Button
          icon={<LogOut aria-hidden className="size-4" />}
          pending={disconnecting}
          onClick={async () => {
            await disconnect();
            onClose();
          }}
        >
          Disconnect
        </Button>
      }
    >
      <InsetPanel className="flex items-center justify-between gap-3">
        <span className="min-w-0 text-body break-all">{address}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy address"}
          className="shrink-0 rounded-control p-2 text-ink-secondary hover:bg-surface hover:text-ink"
        >
          {copied ? (
            <Check aria-hidden className="size-4 text-open" />
          ) : (
            <Copy aria-hidden className="size-4" />
          )}
        </button>
      </InsetPanel>
    </Dialog>
  );
}
