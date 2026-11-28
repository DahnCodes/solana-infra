import { ChevronDown } from "lucide-react";
import { useId, type ComponentProps, type ReactNode } from "react";
import { cx } from "@/lib/cx";

type SelectProps = Omit<ComponentProps<"select">, "id"> & {
  label: string;
  options: { value: string; label: string }[];
  hint?: ReactNode;
  error?: ReactNode;
};

/** A native select in the Input's style: label, hint and error below. */
export function Select({
  label,
  options,
  hint,
  error,
  className,
  ...rest
}: SelectProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <label htmlFor={id} className="text-title2 font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={note ? noteId : undefined}
          className={cx(
            "h-11 w-full appearance-none rounded-control border bg-surface pr-10 pl-3 text-body text-ink",
            error ? "border-tripped" : "border-line-strong",
          )}
          {...rest}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-ink-secondary"
        />
      </div>
      {note && (
        <p
          id={noteId}
          className={cx("text-body", error ? "text-ink" : "text-ink-muted")}
        >
          {note}
        </p>
      )}
    </div>
  );
}
