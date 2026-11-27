"use client";

import { useCallback, useState } from "react";
import type { BreakglassClient, ClientError } from "@/lib/breakglass";
import { getBreakglassClient } from "@/lib/breakglass/create-client";
import { isClientError } from "@/lib/breakglass/errors";

export type WriteState<R> = {
  /** Sends the write; resolves with its result, or rejects with a ClientError. */
  run: () => Promise<R>;
  /** True while the transaction is in flight. */
  pending: boolean;
  /** The last failure, cleared when the write is sent again. */
  error: ClientError | null;
  /** The last confirmed result. */
  result: R | null;
};

/**
 * Wraps one BreakglassClient write with its pending and error state.
 * Reads refresh by themselves after it succeeds (the client notifies).
 *
 *   const freeze = useWrite((c) => c.freezeHeld({ config, hold }));
 *   <Button pending={freeze.pending} onClick={freeze.run}>Freeze hold</Button>
 *
 * Step 5.1 puts a confirm dialog in front of every write, and 5.2 adds the
 * explorer link.
 */
export function useWrite<R>(
  write: (client: BreakglassClient) => Promise<R>,
): WriteState<R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [result, setResult] = useState<R | null>(null);

  const run = useCallback(async () => {
    setPending(true);
    setError(null);
    try {
      const value = await write(getBreakglassClient());
      setResult(value);
      return value;
    } catch (thrown) {
      if (isClientError(thrown)) setError(thrown);
      throw thrown;
    } finally {
      setPending(false);
    }
  }, [write]);

  return { run, pending, error, result };
}
