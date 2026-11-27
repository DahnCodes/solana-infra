import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/lib/cx";

type PanelProps = Omit<ComponentProps<"section">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  /** Buttons or a badge shown at the top right. */
  actions?: ReactNode;
};

/** A white card on the canvas: the main container of every screen. */
export function Panel({
  title,
  description,
  actions,
  className,
  children,
  ...rest
}: PanelProps) {
  const hasHeader = title || description || actions;
  return (
    <section
      className={cx("rounded-card bg-surface p-6 sm:p-10", className)}
      {...rest}
    >
      {hasHeader && (
        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            {title && <h2 className="text-h5 font-medium">{title}</h2>}
            {description && (
              <p className="text-title1 text-ink-secondary">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** A hairline-bordered panel inside a card: previews, tables, details. */
export function InsetPanel({ className, ...rest }: ComponentProps<"div">) {
  return (
    <div
      className={cx(
        "rounded-panel border border-line bg-surface-inset p-4",
        className,
      )}
      {...rest}
    />
  );
}
