"use client";

import { PenLine } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/button";
import { Dialog } from "@/components/dialog";
import { InsetPanel } from "@/components/panel";
import { useToast, type ToastMessage } from "@/components/toast";
import type { BreakglassClient } from "@/lib/breakglass";
import { getBreakglassClient } from "@/lib/breakglass/create-client";
import { isClientError } from "@/lib/breakglass/errors";
import { messageFor } from "@/lib/breakglass/messages";

/** What a failed write means, in words. */
export function explainError(error: unknown): string {
  if (!isClientError(error)) return "Something went wrong. Try again.";
  return messageFor(error.errorName) ?? error.message;
}

export type TxRequest<R> = {
  /** The question, such as "Freeze this hold?". */
  title: string;
  /** What will happen, in one or two plain sentences. */
  summary: ReactNode;
  /** The key facts: amount, who, how long. */
  details?: { label: string; value: ReactNode }[];
  /** The button that signs, named after the action: "Freeze hold". */
  confirmLabel: string;
  /** The write itself. */
  run: (client: BreakglassClient) => Promise<R>;
  /** The toast after it is confirmed. */
  done: string | ToastMessage | ((result: R) => ToastMessage);
  /** Called once the person confirms, before the write is sent. */
  onStart?: () => void;
  /** False for writes that need no wallet signature (the monitor's ack). */
  signs?: boolean;
  /** Called with the reason in words if the write fails. */
  onError?: (message: string) => void;
};

type Pending = {
  request: TxRequest<unknown>;
  resolve: (confirmed: boolean) => void;
};

type TxContextValue = {
  /**
   * Shows the summary and, if the person confirms, sends the write and
   * reports how it went. Resolves with the result, or null if they cancel
   * or it fails (the failure is already shown).
   */
  send: <R>(request: TxRequest<R>) => Promise<R | null>;
};

const TxContext = createContext<TxContextValue | null>(null);

/**
 * Every write in the app goes through here (steps 5.1 and 5.2): a plain
 * summary to confirm first, then the transaction and its outcome.
 */
export function TxProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  const ask = useCallback(
    (request: TxRequest<unknown>) =>
      new Promise<boolean>((resolve) => {
        const p = { request, resolve };
        pendingRef.current = p;
        setPending(p);
      }),
    [],
  );

  const answer = useCallback((confirmed: boolean) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    p?.resolve(confirmed);
  }, []);

  const send = useCallback(
    async <R,>(request: TxRequest<R>): Promise<R | null> => {
      const confirmed = await ask(request as TxRequest<unknown>);
      if (!confirmed) return null;
      request.onStart?.();
      try {
        const result = await request.run(getBreakglassClient());
        toast.show(
          typeof request.done === "string"
            ? { tone: "open", title: request.done }
            : typeof request.done === "function"
              ? request.done(result)
              : request.done,
        );
        return result;
      } catch (error) {
        const message = explainError(error);
        request.onError?.(message);
        toast.show({
          tone: "tripped",
          title: `${request.confirmLabel} didn't go through`,
          description: message,
        });
        return null;
      }
    },
    [ask, toast],
  );

  const value = useMemo(() => ({ send }), [send]);
  const request = pending?.request;

  return (
    <TxContext value={value}>
      {children}
      <Dialog
        open={pending !== null}
        onClose={() => answer(false)}
        title={request?.title ?? ""}
        actions={
          <>
            <Button variant="quiet" onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<PenLine aria-hidden className="size-4" />}
              onClick={() => answer(true)}
            >
              {request?.confirmLabel ?? "Confirm"}
            </Button>
          </>
        }
      >
        {request && (
          <div className="flex flex-col gap-4">
            <p className="text-body">{request.summary}</p>
            {request.details && request.details.length > 0 && (
              <InsetPanel>
                <dl className="flex flex-col gap-2 text-body">
                  {request.details.map((d) => (
                    <div
                      key={d.label}
                      className="flex flex-wrap justify-between gap-x-4"
                    >
                      <dt className="text-ink-secondary">{d.label}</dt>
                      <dd className="text-right">{d.value}</dd>
                    </div>
                  ))}
                </dl>
              </InsetPanel>
            )}
            {request.signs !== false && (
              <p className="text-body text-ink-muted">
                Your wallet will ask you to sign. Nothing happens until you do.
              </p>
            )}
          </div>
        )}
      </Dialog>
    </TxContext>
  );
}

export function useTx(): TxContextValue {
  const context = useContext(TxContext);
  if (!context) throw new Error("useTx must be used inside TxProvider.");
  return context;
}
