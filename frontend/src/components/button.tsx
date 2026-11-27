import { LoaderCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "secondary" | "quiet";

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-on-primary hover:bg-primary-hover disabled:bg-surface-inset disabled:text-ink-muted",
  secondary:
    "border border-line-strong bg-surface text-ink hover:bg-surface-inset disabled:border-line disabled:text-ink-muted disabled:hover:bg-surface",
  quiet:
    "text-ink hover:bg-surface-inset disabled:text-ink-muted disabled:hover:bg-transparent",
};

type ButtonProps = ComponentProps<"button"> & {
  /** One primary button per view; secondary is the default. */
  variant?: ButtonVariant;
  /** Icon before the label (a Lucide icon element). */
  icon?: ReactNode;
  /** Shows a spinner and blocks clicks while a transaction is in flight. */
  pending?: boolean;
};

export function Button({
  variant = "secondary",
  icon,
  pending = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cx(
        "inline-flex h-11 items-center justify-center gap-2 rounded-control px-4 font-label text-body font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {pending ? (
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
      ) : (
        icon
      )}
      {children}
    </button>
  );
}
