"use client";

import { X } from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  type ReactNode,
} from "react";

type DialogProps = {
  open: boolean;
  /** Called on Escape, the close button, or a click outside the dialog. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons at the bottom right, the main action last. */
  actions?: ReactNode;
};

/**
 * A modal dialog on the native <dialog> element, which traps focus, closes on
 * Escape and returns focus to the button that opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  actions,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // `open` is the only source of truth. Escape is handled in onKeyDown below
  // (the browser's own close is blocked), because some browsers never fire
  // the dialog's close event. If a browser closes it anyway, this tells the
  // owner, so the dialog can open again.
  const closedByBrowser = useEffectEvent(() => {
    if (open) onClose();
  });
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const handle = () => closedByBrowser();
    dialog.addEventListener("close", handle);
    return () => dialog.removeEventListener("close", handle);
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the <dialog> element itself.
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto w-full max-w-lg rounded-card bg-surface p-0 text-ink shadow-float backdrop:bg-scrim"
    >
      <div className="flex flex-col gap-6 p-6 sm:p-8">
        <header className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <h2 id={titleId} className="text-h5 font-medium">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="text-body text-ink-secondary">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mt-1 -mr-2 rounded-control p-2 text-ink-secondary hover:bg-surface-inset hover:text-ink"
          >
            <X aria-hidden className="size-5" />
          </button>
        </header>
        {children}
        {actions && (
          <footer className="flex flex-wrap justify-end gap-2">
            {actions}
          </footer>
        )}
      </div>
    </dialog>
  );
}
