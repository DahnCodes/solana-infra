import { cx } from "@/lib/cx";

/** The Breakglass mark: a pane of glass with a crack through it. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={cx("size-6", className)}
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M13.5 3.5 11 9l3 2.5-2.5 4.5 1.5 4.5" />
    </svg>
  );
}

/** The mark and the name, as a link home. */
export function Logo({
  hideNameOnPhone = false,
}: {
  hideNameOnPhone?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-ink">
      <LogoMark />
      <span
        className={cx(
          "text-title1 font-semibold tracking-tight",
          hideNameOnPhone && "max-sm:sr-only",
        )}
      >
        Breakglass
      </span>
    </span>
  );
}
