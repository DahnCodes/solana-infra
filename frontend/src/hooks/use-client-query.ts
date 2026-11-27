"use client";

import { useEffect, useEffectEvent, useState } from "react";
import type { BreakglassClient } from "@/lib/breakglass";
import { getBreakglassClient } from "@/lib/breakglass/create-client";

export type QueryResult<T> = {
  /** The latest data; kept while a refresh runs, so screens don't flicker. */
  data: T | undefined;
  /** The last failure, cleared by the next success. */
  error: unknown;
  /** True until the first result (or error) for the current key. */
  loading: boolean;
};

type State<T> = { key: string; data?: T; error?: unknown; settled: boolean };

/**
 * Reads from the BreakglassClient and reads again whenever the client says
 * state may have changed (after every write, a wallet switch, a mock clock
 * jump, or a live update). `key` names the read: a new key starts a fresh
 * read; null skips reading (for example, until an address is known).
 *
 * The client is only touched in the browser: the server render and the
 * first client render both show the loading state.
 */
export function useClientQuery<T>(
  key: string | null,
  read: (client: BreakglassClient) => Promise<T>,
): QueryResult<T> {
  const [state, setState] = useState<State<T> | null>(null);
  const readLatest = useEffectEvent(read);

  useEffect(() => {
    if (key === null) return;
    const client = getBreakglassClient();
    let latest = 0;
    let active = true;

    const run = () => {
      const id = ++latest;
      readLatest(client).then(
        (data) => {
          if (active && id === latest) {
            setState({ key, data, error: undefined, settled: true });
          }
        },
        (error: unknown) => {
          if (active && id === latest) {
            setState((prev) => ({
              key,
              data: prev?.key === key ? prev.data : undefined,
              error,
              settled: true,
            }));
          }
        },
      );
    };

    run();
    const stop = client.subscribe(run);
    return () => {
      active = false;
      stop();
    };
  }, [key]);

  // A state left over from another key doesn't count.
  const current = key !== null && state?.key === key ? state : null;
  return {
    data: current?.data,
    error: current?.error,
    loading: key !== null && !current?.settled,
  };
}
