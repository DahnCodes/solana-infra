"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, type PublicKey } from "@solana/web3.js";
import { Coins, Droplet, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Amount } from "@/components/amount";
import { Button } from "@/components/button";
import { useNetwork } from "@/components/network/use-network";
import { useMockControls, useTokenBalance } from "@/hooks/use-breakglass";
import { walletTokenAccount } from "@/lib/breakglass/mock/engine";

const USDC_DECIMALS = 6;
const TEST_USDC = BigInt(10_000) * BigInt(10 ** USDC_DECIMALS);
const WEB_FAUCET = "https://faucet.solana.com";

type Note = { tone: "ok" | "problem"; text: string } | null;

/**
 * Funds a new wallet for the demo: devnet SOL for transaction fees (a real
 * devnet airdrop) and test USDC to deposit (mock USDC in mock mode; the
 * backend's test mint in live mode, after checkpoint B).
 */
export function Faucet() {
  const { publicKey } = useWallet();
  if (!publicKey) return null;
  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-label text-caption font-semibold text-ink-muted uppercase">
        Fund this wallet
      </h3>
      <SolRow owner={publicKey} />
      <UsdcRow />
    </div>
  );
}

/**
 * SOL for transaction fees. Devnet's RPC airdrop is closed (it answers 410
 * and points to the web faucet), so on devnet this copies the address and
 * opens faucet.solana.com; a local validator still airdrops directly.
 */
function SolRow({ owner }: { owner: PublicKey }) {
  const { connection } = useConnection();
  const { cluster, problem } = useNetwork();
  const [lamports, setLamports] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    let active = true;
    connection.getBalance(owner).then(
      (value) => {
        if (active) setLamports(value);
      },
      () => {
        if (active) setLamports(null);
      },
    );
    return () => {
      active = false;
    };
  }, [connection, owner, refresh]);

  // Coming back from the web faucet tab shows the new balance.
  useEffect(() => {
    const onFocus = () => setRefresh((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const openWebFaucet = async () => {
    try {
      await navigator.clipboard.writeText(owner.toBase58());
      setNote({
        tone: "ok",
        text: "Your address is copied. On the faucet page, paste it, pick Devnet and request SOL. Your balance here updates when you come back.",
      });
    } catch {
      setNote({
        tone: "ok",
        text: "On the faucet page, paste your address, pick Devnet and request SOL.",
      });
    }
    window.open(WEB_FAUCET, "_blank", "noopener,noreferrer");
  };

  const airdrop = async () => {
    setPending(true);
    setNote(null);
    try {
      const signature = await connection.requestAirdrop(
        owner,
        LAMPORTS_PER_SOL,
      );
      const latest = await connection.getLatestBlockhash();
      await connection.confirmTransaction(
        { signature, ...latest },
        "confirmed",
      );
      setNote({ tone: "ok", text: "1 SOL received." });
      setRefresh((n) => n + 1);
    } catch {
      setNote({
        tone: "problem",
        text: "The airdrop didn't go through. Is the local validator running?",
      });
    } finally {
      setPending(false);
    }
  };

  const local = cluster === "localnet";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-body">
          <span className="text-ink-secondary">SOL for fees: </span>
          {lamports === null ? (
            "…"
          ) : (
            <Amount
              value={BigInt(lamports)}
              decimals={9}
              symbol="SOL"
              maxFractionDigits={4}
            />
          )}
        </span>
        {local ? (
          <Button
            icon={<Droplet aria-hidden className="size-4" />}
            pending={pending}
            onClick={airdrop}
          >
            Airdrop 1 SOL
          </Button>
        ) : (
          <Button
            icon={<ExternalLink aria-hidden className="size-4" />}
            disabled={problem?.kind === "mainnet"}
            onClick={openWebFaucet}
          >
            Get devnet SOL
          </Button>
        )}
      </div>
      {note && <NoteLine note={note} />}
    </div>
  );
}

function UsdcRow() {
  const mock = useMockControls();
  const wallet = mock?.wallet ?? null;
  const balance = useTokenBalance(
    mock && wallet ? walletTokenAccount(wallet, mock.testVault.mint) : null,
  );
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState<Note>(null);

  if (!mock) {
    return (
      <p className="text-body text-ink-secondary">
        Test USDC comes from the demo protocol&apos;s test mint on devnet,
        available once it is deployed.
      </p>
    );
  }

  const request = async () => {
    setPending(true);
    setNote(null);
    try {
      await mock.requestTestTokens(TEST_USDC);
      setNote({ tone: "ok", text: "10,000 test USDC added (mock)." });
    } catch {
      setNote({ tone: "problem", text: "Couldn't add test USDC. Try again." });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-body">
          <span className="text-ink-secondary">Test USDC: </span>
          {balance.data === undefined ? (
            "…"
          ) : (
            <Amount
              value={balance.data}
              decimals={USDC_DECIMALS}
              symbol="USDC"
            />
          )}
        </span>
        <Button
          icon={<Coins aria-hidden className="size-4" />}
          pending={pending}
          onClick={request}
        >
          Get 10,000 test USDC
        </Button>
      </div>
      {note && <NoteLine note={note} />}
    </div>
  );
}

function NoteLine({ note }: { note: NonNullable<Note> }) {
  return (
    <p
      role="status"
      className={
        note.tone === "ok"
          ? "text-body text-ink-secondary"
          : "text-body text-ink"
      }
    >
      {note.text}
    </p>
  );
}
