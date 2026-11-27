"use client";

import { useSyncExternalStore } from "react";

// One shared one-second ticker for every component that shows live time.
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(onTick: () => void): () => void {
  listeners.add(onTick);
  if (timer === undefined) {
    timer = window.setInterval(() => listeners.forEach((l) => l()), 1000);
  }
  return () => {
    listeners.delete(onTick);
    if (listeners.size === 0) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

const getSnapshot = () => Math.floor(Date.now() / 1000);

// The server never reads the clock (Cache Components forbids it in the
// prerendered shell), so the first render shows a placeholder.
const getServerSnapshot = () => null;

/** Current unix time in seconds, updated every second; null before hydration. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
