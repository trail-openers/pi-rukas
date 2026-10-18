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
 *
 * #1326 — only a declared subset of kinds is a host contract
 * (NDJSON_STABLE_FIELDS, versioned by NDJSON_STABLE_VERSION): for those, the
 * named `event` fields keep their name and meaning within the version. Every
 * other kind is the driver's internal event union passed through, and its
 * line carries `unstable: true` — it may be renamed or reshaped at any time.
 */

import type { WorkEvent } from "../workflow-state-events.ts";
import { KNOWN_EVENT_KINDS } from "../workflow-state-validate.ts";

export const NDJSON_VERSION = 1 as const;

export const NDJSON_EXTRA_KINDS = ["log", "pi-resolved"] as const;

export const NDJSON_KINDS: readonly string[] = [...KNOWN_EVENT_KINDS, ...NDJSON_EXTRA_KINDS];

/** Version of the stable subset. Bump when a stable kind or field is removed or changes meaning. */
export const NDJSON_STABLE_VERSION = 1 as const;

type EventFields<K extends WorkEvent["kind"]> = readonly Exclude<
  keyof Extract<WorkEvent, { kind: K }>,
  "kind"
>[];

/**
 * The stable driver-event kinds and the `event` fields guaranteed on each
 * (optional fields may be absent). Typed against WorkEvent, so renaming one
 * of these fields in the driver fails `tsc` here instead of breaking a host.
 */
export const NDJSON_STABLE_FIELDS = {
  "step-started": ["step", "at", "round"],
  "dispatch-started": ["step", "role", "jobId", "at"],
  "dispatch-completed": ["step", "role", "jobId", "ok", "ms", "at", "usage"],
  // #1415 — the driver's verify gate is a host-visible duration, not an
  // internal detail: the whole point of the pair is that a host (and a human
  // reading the host's log) can see the gate running instead of watching an
  // unexplained ~22-minute gap. `command`, `step` and `at` are the identity of
  // the run; `ms`/`status` on the completion are the answer.
  "verify-started": ["step", "command", "at"],
  "verify-completed": ["step", "command", "status", "ms", "at"],
  "cap-hit": ["cap", "at", "nextStep"],
  "handoff-emitted": ["at", "commentUrl", "labelApplied"],
  "ci-status": ["at", "status", "runUrl"],
  merged: ["at", "prNumber", "mergeCommit"],
  interrupted: ["at", "reason", "step"],
} as const satisfies { [K in WorkEvent["kind"]]?: EventFields<K> };

/** Stable kinds: the driver events above plus the runner's own `log` line. */
export const NDJSON_STABLE_KINDS: readonly string[] = [...Object.keys(NDJSON_STABLE_FIELDS), "log"];

/** Whether lines of `kind` are part of the stable subset. */
export function isStableKind(kind: string): boolean {
  return NDJSON_STABLE_KINDS.includes(kind);
}

export interface NdjsonLine {
  v: typeof NDJSON_VERSION;
  kind: string;
  at: string;
  issue?: number;
  key?: string;
  event?: unknown;
  message?: string;
  /** On a `log` line the runner rerouted from a warning (#1370); absent otherwise. */
  level?: "warn";
  /** Present (always `true`) on a line whose kind is outside the stable subset. */
  unstable?: true;
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
  // Lenient on absence: a line written before #1326 carries no marker.
  if (o.unstable !== undefined && o.unstable !== true)
    errors.push("unstable, when present, is true");
  if (o.unstable === true && typeof o.kind === "string" && isStableKind(o.kind)) {
    errors.push(`kind "${o.kind}" is stable and must not be marked unstable`);
  }
  if (o.level !== undefined && o.level !== "warn") errors.push('level, when present, is "warn"');
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
