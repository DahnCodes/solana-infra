import { CircleAlert } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "@/lib/cx";

type InputProps = Omit<ComponentProps<"input">, "id"> & {
  label: string;
  /** Help shown under the field. */
  hint?: ReactNode;
  /** Replaces the hint and marks the field invalid. */
  error?: ReactNode;
  /** Unit shown inside the field on the right, such as a token symbol. */
  suffix?: ReactNode;
};

export function Input({
  label,
  hint,
  error,
  suffix,
  className,
  ...rest
}: InputProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;

  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-title2 font-medium text-ink">
        {label}
      </label>
      <div
        className={cx(
          "flex h-11 items-center rounded-control border bg-surface focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary",
          error ? "border-tripped" : "border-line-strong",
        )}
      >
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-body text-ink outline-none placeholder:text-ink-muted"
          {...rest}
        />
        {suffix && (
          <span className="pr-3 text-body text-ink-secondary">{suffix}</span>
        )}
      </div>
      {note && (
        <p
          id={noteId}
          className={cx(
            "flex items-start gap-1.5 text-body",
            error ? "text-ink" : "text-ink-muted",
          )}
        >
          {error && (
            <CircleAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-tripped"
            />
          )}
          {note}
        </p>
      )}
    </div>
  );
}
