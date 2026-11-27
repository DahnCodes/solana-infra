import { cx } from "@/lib/cx";
import { formatUnits } from "@/lib/format";

export type FigureSize = "inline" | "card" | "hero";

// Inline amounts keep normal figures: Schibsted's tabular comma is too wide
// for running text. Figures that sit in a fixed spot are tabular.
const sizes: Record<FigureSize, string> = {
  inline: "text-body",
  card: "font-figure text-h4 font-light tabular-nums",
  hero: "font-figure text-h1 font-light tabular-nums",
};

type AmountProps = {
  /** Base units (u64), as bigint or a decimal string. */
  value: bigint | string;
  decimals: number;
  symbol?: string;
  /** Cut the fraction to this many digits; the full value is in the tooltip. */
  maxFractionDigits?: number;
  size?: FigureSize;
  className?: string;
};

/** A token amount: tabular figures, the symbol after it in a quieter tone. */
export function Amount({
  value,
  decimals,
  symbol,
  maxFractionDigits,
  size = "inline",
  className,
}: AmountProps) {
  const shown = formatUnits(value, decimals, maxFractionDigits);
  const full = formatUnits(value, decimals);
  return (
    <span
      title={
        full !== shown ? `${full}${symbol ? ` ${symbol}` : ""}` : undefined
      }
      className={cx(sizes[size], className)}
    >
      {/* The number never breaks; on a narrow screen the symbol may wrap. */}
      <span className="whitespace-nowrap">{shown}</span>
      {symbol && (
        <>
          {" "}
          <span className="whitespace-nowrap text-ink-secondary">{symbol}</span>
        </>
      )}
    </span>
  );
}
