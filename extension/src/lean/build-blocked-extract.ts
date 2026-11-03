/**
 * lean/build-blocked-extract — reads the build child's `report_blocked` call,
 * if it made one.
 *
 * Pure: it takes the child's `toolUses` array and returns what it can read,
 * plus a count of the calls it had to skip. Mirrors `extractSubmitTests` — the
 * schema is validated by Pi inside the child, so anything that reaches here
 * with the wrong shape is a call the model faked rather than one Pi accepted,
 * and it is skipped rather than trusted.
 *
 * NOTHING HERE JUDGES whether the report is true. Whether a named path is in
 * the run's frozen map, and whether the named test is actually red, are facts
 * about the run's contract and its tree, and the anti-forgery gate in
 * `build.ts` owns them. This module's job ends at "is this a readable
 * report_blocked call, and what did it say".
 */

/** One reported conflict: a frozen path and the child's stated contradiction. */
export interface BlockedRow {
  path: string;
  reason: string;
}

export interface BlockedExtraction {
  /** The entries of every readable call, in call order. */
  rows: BlockedRow[];
  /** Calls that named the tool but carried nothing readable. */
  skipped: number;
}

/** A path the extractor can hand on: a non-empty string with no NUL. */
function usablePath(p: unknown): p is string {
  return typeof p === "string" && p.trim() !== "" && !p.includes("\0");
}

/** A reason worth printing: prose, non-empty, with no NUL in it. */
function usableReason(r: unknown): r is string {
  return typeof r === "string" && r.trim() !== "" && !r.includes("\0");
}

import { RECORD_MAX_ENTRIES, RECORD_REASON_MAX_CHARS } from "./state-outcome-maps.ts";

/**
 * How many entries one call may contribute and how long one reason may be.
 * Both are the DURABLE record's bounds, read from the module that enforces them
 * at load — the tool's own TypeBox ceiling is the same number because the tool
 * may not accept what the record would refuse, and a fourth literal here is one
 * that no gate pins.
 */
const MAX_ENTRIES = RECORD_MAX_ENTRIES;
const MAX_REASON_CHARS = RECORD_REASON_MAX_CHARS;

/** Clip a reason to the durable record's bound, marking that it was clipped. */
function clipReason(r: string): string {
  const trimmed = r.trim();
  return trimmed.length > MAX_REASON_CHARS ? `${trimmed.slice(0, MAX_REASON_CHARS)}…` : trimmed;
}

export function extractBlockedReport(toolUses: unknown[]): BlockedExtraction {
  const rows: BlockedRow[] = [];
  let skipped = 0;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_blocked" || !t.arguments || typeof t.arguments !== "object") continue;
    const a = t.arguments as Record<string, unknown>;
    const raw = Array.isArray(a.conflicts) ? a.conflicts : [];
    let took = 0;
    for (const entry of raw.slice(0, MAX_ENTRIES)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (!usablePath(e.path) || !usableReason(e.reason)) continue;
      rows.push({ path: e.path.trim(), reason: clipReason(e.reason) });
      took++;
    }
    // A call that lost every entry is not an empty report: `rows: []` would
    // read as "the child named nothing", which is a verdict it did not give. It
    // is a malformed call, and it is counted.
    if (took === 0) skipped++;
  }
  return { rows, skipped };
}
