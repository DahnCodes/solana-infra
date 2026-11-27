"use client";

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/**
 * False during the server render and hydration, true after. Use it to show
 * browser-only state (a wallet, localStorage) without a hydration mismatch.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}
