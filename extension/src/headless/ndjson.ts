/**
 * headless/ndjson — the NDJSON v1 progress schema the headless runner writes to
 * stderr (headless S4, #1024). One JSON object per line.
 *
 * Every line carries `v` (always 1), `kind`, `at` (ISO-8601). `issue` is present
 * when the line belongs to one issue. A driver event line also carries `key`,
 * the idempotency key `<issue>:<index>:<at>`: a resumed cycle re-emits its prior
 * event log, so a consumer dedupes on `key`. The event itself rides under
 * `event` (its own `kind` would collide with the envelope's).
 *
 * Kinds: every WorkEvent kind (KNOWN_EVENT_KINDS) plus `log` (a line the driver
 * would have sent to the chat) and `pi-resolved` (the Pi binary the run uses).
 * #1022 documents this schema; this module is its source of truth.
 */

import { KNOWN_EVENT_KINDS } from "../workflow-state-validate.ts";

export const NDJSON_VERSION = 1 as const;

export const NDJSON_EXTRA_KINDS = ["log", "pi-resolved"] as const;

export const NDJSON_KINDS: readonly string[] = [...KNOWN_EVENT_KINDS, ...NDJSON_EXTRA_KINDS];

export interface NdjsonLine {
  v: typeof NDJSON_VERSION;
  kind: string;
  at: string;
  issue?: number;
  key?: string;
  event?: unknown;
  message?: string;
  path?: string;
  source?: string;
}

/** Build the idempotency key for a driver event. */
export function eventKey(issue: number, index: number, at: number): string {
  return `${issue}:${index}:${at}`;
}

/** Serialise one line (no trailing newline). */
export function formatLine(line: NdjsonLine): string {
  return JSON.stringify(line);
}

/**
 * Validate one parsed line against v1. Returns the list of violations; empty
 * means the line is valid.
 */
export function validateNdjsonLine(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["line is not a JSON object"];
  }
  const o = value as Record<string, unknown>;
  const errors: string[] = [];
  if (o.v !== NDJSON_VERSION) errors.push(`v must be ${NDJSON_VERSION}`);
  if (typeof o.kind !== "string") errors.push("kind is required (string)");
  else if (!NDJSON_KINDS.includes(o.kind)) errors.push(`kind "${o.kind}" is not a v1 kind`);
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) {
    errors.push("at must be an ISO-8601 timestamp");
  }
  if (o.issue !== undefined && (typeof o.issue !== "number" || !Number.isInteger(o.issue))) {
    errors.push("issue, when present, must be an integer");
  }
  const isDriverEvent =
    typeof o.kind === "string" && (KNOWN_EVENT_KINDS as readonly string[]).includes(o.kind);
  if (isDriverEvent && o.issue !== undefined && typeof o.key !== "string") {
    errors.push("driver event lines carry key");
  }
  return errors;
}
