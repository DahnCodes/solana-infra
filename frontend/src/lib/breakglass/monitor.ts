/**
 * Monitor HTTP API types (docs/FRONTEND.md section 7; backend phase 5,
 * extended in phase 6). These are JSON shapes exactly as the API sends
 * them: snake_case keys, RFC 3339 time strings, amounts as decimal strings
 * and keys as base58 strings.
 */
import type { HoldStatus } from "./accounts.ts";
import type { BreakglassEventName } from "./events.ts";

export type Severity = "info" | "warning" | "high" | "critical";

export type IncidentStatus = "open" | "acked" | "resolved";

/** A group of related alerts opened by a detector. */
export type Incident = {
  id: string;
  /** The protected program's address. */
  protocol: string;
  detector: string;
  severity: Severity;
  title: string;
  status: IncidentStatus;
  opened_at: string;
  acked_by: string | null;
  acked_at: string | null;
  signatures: string[];
};

/** GET /incidents/:id adds the incident's events and alerts. */
export type IncidentDetail = Incident & {
  events: MonitorEvent[];
  alerts: Alert[];
};

/** An event's name as the monitor sends it: the Rust struct name. */
export type MonitorEventKind = Capitalize<BreakglassEventName>;

/** "limitTripped" → "LimitTripped". */
export const monitorEventKind = (name: BreakglassEventName): MonitorEventKind =>
  (name.charAt(0).toUpperCase() + name.slice(1)) as MonitorEventKind;

/** A Breakglass event as the monitor stores it. */
export type MonitorEvent = {
  id: string;
  /** The Rust struct name, such as "LimitTripped" (not camelCase). */
  kind: MonitorEventKind | (string & {});
  signature: string;
  slot: number;
  block_time: string;
  /** The event's fields, camelCase, with u64 values as decimal strings. */
  data: Record<string, unknown>;
};

/** A held withdrawal mirrored from its PendingWithdrawal account. */
export type MonitorHold = {
  address: string;
  owner: string;
  mint: string;
  amount: string;
  nonce: string;
  created_at: string;
  release_at: string;
  status: HoldStatus;
};

/** One notification sent for an incident. */
export type Alert = {
  id: string;
  sink: string;
  sent_at: string;
  ok: boolean;
};

/** GET /health */
export type MonitorHealth = {
  status: "ok" | "degraded";
  rpc: { url: string; last_slot: number; lag_secs: number; alive: boolean }[];
};

/** Every list endpoint: ?limit= (default 50, max 500) and ?cursor=. */
export type Page<T> = {
  items: T[];
  next_cursor: string | null;
};

/** Body of POST /incidents/:id/ack (needs the bearer token). */
export type AckRequest = {
  by: string;
  note?: string;
};

/** Error body, sent with a matching HTTP status. */
export type MonitorError = {
  error: { code: string; message: string };
};

/** One message on GET /stream (Server-Sent Events, backend phase 5). */
export type StreamMessage =
  { type: "event"; data: MonitorEvent } | { type: "incident"; data: Incident };
