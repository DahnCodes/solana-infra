"use client";

import { useSyncExternalStore } from "react";

/*
 * The wallet adapter reports connection errors (rejected request, wallet not
 * ready, …) through the provider's onError. This tiny store hands the latest
 * one to the wallet button, which shows it and clears it.
 */

let latest: string | null = null;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function reportWalletError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  latest = message || "The wallet didn't respond. Try again.";
  emit();
}

export function clearWalletError() {
  if (latest === null) return;
  latest = null;
  emit();
}

export function useWalletError(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => latest,
    () => null,
  );
}
