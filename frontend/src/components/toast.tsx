"use client";

import {
  CircleCheck,
  CircleX,
  Clock,
  Info,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "@/lib/cx";

export type ToastTone = "info" | "pending" | "open" | "held" | "tripped";

export type ToastMessage = {
  tone?: ToastTone;
  title: ReactNode;
  description?: ReactNode;
  /** Optional link or button, such as "View on explorer". */
  action?: ReactNode;
};

const icons: Record<ToastTone, ReactNode> = {
  info: <Info aria-hidden className="size-5 text-ink-secondary" />,
  pending: (
    <LoaderCircle
      aria-hidden
      className="size-5 animate-spin text-ink-secondary"
    />
  ),
  open: <CircleCheck aria-hidden className="size-5 text-open" />,
  held: <Clock aria-hidden className="size-5 text-held" />,
  tripped: <CircleX aria-hidden className="size-5 text-tripped" />,
};

/** The card a toast shows. Also usable on its own, as on the components page. */
export function ToastCard({
  tone = "info",
  title,
  description,
  action,
  onDismiss,
  className,
}: ToastMessage & { onDismiss?: () => void; className?: string }) {
  return (
    <div
      className={cx(
        "flex w-full max-w-sm items-start gap-3 rounded-panel border border-line bg-surface p-4 text-ink shadow-float",
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">{icons[tone]}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-title2 font-medium">{title}</p>
        {description && (
          <p className="text-body text-ink-secondary">{description}</p>
        )}
        {action && <div className="mt-1">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-1 -mr-1 rounded-control p-1 text-ink-secondary hover:bg-surface-inset hover:text-ink"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  );
}

export type ToastOptions = {
  /** Stay until updated or dismissed (a transaction still in flight). */
  persist?: boolean;
  /** How long it stays otherwise, in ms. */
  durationMs?: number;
};

type ToastContextValue = {
  /** Shows a toast and returns its id. */
  show: (message: ToastMessage, options?: ToastOptions) => number;
  /** Replaces a toast's content in place, such as pending → confirmed. */
  update: (id: number, message: ToastMessage, options?: ToastOptions) => void;
  dismiss: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

/** How long a toast stays before it dismisses itself. */
const TOAST_MS = 6000;

/** Holds the toasts and shows them bottom right. Wrap the app once. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<(ToastMessage & { id: number })[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, options?: ToastOptions) => {
      window.clearTimeout(timers.current.get(id));
      if (options?.persist) return;
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), options?.durationMs ?? TOAST_MS),
      );
    },
    [dismiss],
  );

  const show = useCallback(
    (message: ToastMessage, options?: ToastOptions) => {
      const id = nextId.current++;
      setToasts((current) => [...current, { ...message, id }]);
      schedule(id, options);
      return id;
    },
    [schedule],
  );

  const update = useCallback(
    (id: number, message: ToastMessage, options?: ToastOptions) => {
      setToasts((current) =>
        current.some((t) => t.id === id)
          ? current.map((t) => (t.id === id ? { ...message, id } : t))
          : [...current, { ...message, id }],
      );
      schedule(id, options);
    },
    [schedule],
  );

  const value = useMemo(
    () => ({ show, update, dismiss }),
    [show, update, dismiss],
  );

  return (
    <ToastContext value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6"
      >
        {toasts.map(({ id, ...message }) => (
          <ToastCard
            key={id}
            {...message}
            onDismiss={() => dismiss(id)}
            className="pointer-events-auto"
          />
        ))}
      </div>
    </ToastContext>
  );
}

/** Shows a toast: `useToast().show({ tone: "open", title: "Hold frozen" })`. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider.");
  return context;
}
