"use client";

import { CircleAlert, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/button";
import { InsetPanel } from "@/components/panel";
import type { QueryResult } from "@/hooks/use-client-query";
import { isClientError } from "@/lib/breakglass/errors";
import { messageFor } from "@/lib/breakglass/messages";

/** Grey placeholder lines while something loads. */
export function Skeleton({
  rows = 3,
  label,
}: {
  rows?: number;
  label: string;
}) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className="flex flex-col gap-3"
    >
      {Array.from({ length: rows }, (_, i) => (
        <span
          key={i}
          className="h-5 rounded-control bg-surface-inset motion-safe:animate-pulse"
          style={{ width: `${90 - ((i * 17) % 35)}%` }}
        />
      ))}
    </div>
  );
}

function reason(error: unknown): string {
  if (isClientError(error)) {
    return messageFor(error.errorName) ?? error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** A read that failed, with what failed, why, and a way to try again. */
export function ErrorNote({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <InsetPanel
      role="alert"
      className="flex flex-wrap items-start justify-between gap-3"
    >
      <span className="flex items-start gap-2 text-body">
        <CircleAlert
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-tripped"
        />
        <span>
          Couldn&apos;t load {what}.{" "}
          <span className="text-ink-secondary">{reason(error)}</span>
        </span>
      </span>
      {onRetry && (
        <Button
          variant="quiet"
          icon={<RotateCw aria-hidden className="size-4" />}
          onClick={onRetry}
        >
          Try again
        </Button>
      )}
    </InsetPanel>
  );
}

/** A quiet line when a refresh failed but older data is still on screen. */
function StaleNote({ onRetry }: { onRetry: () => void }) {
  return (
    <p
      role="status"
      className="mb-3 flex flex-wrap items-center gap-2 text-body text-ink-muted"
    >
      <CircleAlert aria-hidden className="size-4 text-held" />
      Couldn&apos;t refresh: showing the last known data.
      <button
        type="button"
        onClick={onRetry}
        className="text-ink underline underline-offset-4"
      >
        Try again
      </button>
    </p>
  );
}

/**
 * Everything a panel shows besides its content: a skeleton while the first
 * read runs, an error with a retry if it failed, or a note when a refresh
 * failed and older data is still shown. Renders nothing once data is fresh.
 * Pair it with `query.data !== undefined && …` for the content itself.
 */
export function QueryStatus<T>({
  query,
  what,
  rows,
}: {
  query: QueryResult<T>;
  what: string;
  rows?: number;
}) {
  if (query.data === undefined) {
    return query.error ? (
      <ErrorNote what={what} error={query.error} onRetry={query.retry} />
    ) : (
      <Skeleton rows={rows} label={what} />
    );
  }
  return query.error ? <StaleNote onRetry={query.retry} /> : null;
}

/**
 * The four states of a panel that reads data, so none is ever blank or
 * stuck: a skeleton while loading, an error with a retry if the first read
 * fails, an empty state, or the content (with a note if a later refresh
 * failed and the data shown may be old).
 */
export function QueryView<T>({
  query,
  what,
  rows,
  isEmpty,
  empty,
  children,
}: {
  query: QueryResult<T>;
  /** What is loading, for people: "held withdrawals". */
  what: string;
  rows?: number;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.data === undefined) {
    if (query.error) {
      return (
        <ErrorNote what={what} error={query.error} onRetry={query.retry} />
      );
    }
    return <Skeleton rows={rows} label={what} />;
  }
  return (
    <>
      {query.error ? <StaleNote onRetry={query.retry} /> : null}
      {isEmpty?.(query.data) ? empty : children(query.data)}
    </>
  );
}
