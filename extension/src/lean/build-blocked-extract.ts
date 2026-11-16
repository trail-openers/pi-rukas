/**
 * lean/build-blocked-extract — reads the build child's `report_blocked` call, if it
 * made one.
 *
 * Pure: takes the child's `toolUses` array and returns what it can read, plus a count of calls it had to
 * skip. Mirrors `extractSubmitTests` — Pi validates the schema inside the child, so anything reaching here
 * with the wrong shape is a call the model faked rather than one Pi accepted.
 *
 * NOTHING HERE JUDGES whether the report is true. Whether a named path is in the run's frozen map, and
 * whether the named test is red, are facts about the contract and the tree, and the anti-forgery gate in
 * `build.ts` owns them.
 *
 * The entry cap is the WHOLE extraction's, not one call's: the durable record holds one bounded `blockedBy`
 * map, and rows past the bound are dropped and counted in `skipped`.
 */

/** One reported conflict: a frozen path and the child's stated contradiction. */
interface BlockedRow {
  path: string;
  reason: string;
}

interface BlockedExtraction {
  /** The entries of every readable call, in call order — at most `MAX_ENTRIES` of them. */
  rows: BlockedRow[];
  /** Readable entries this extraction could not take: malformed calls, and rows past the cap. */
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

/** An entry the extraction may carry: an object whose path and reason both read. */
function isBlockedRow(entry: unknown): entry is BlockedRow {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return usablePath(e.path) && usableReason(e.reason);
}

import { RECORD_MAX_ENTRIES, RECORD_REASON_MAX_CHARS } from "./state-outcome-maps.ts";

/**
 * How many entries the whole extraction may hold and how long one reason may be. Both are the DURABLE
 * record's bounds, read from the module that enforces them at load — the tool's own TypeBox ceiling is the
 * same number because the tool may not accept what the record would refuse. The entry bound is the
 * EXTRACTION's, so a child that spread one report across several calls does not pay for a proof the loader
 * then refuses.
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
  let total = 0;
  for (const tu of toolUses) {
    if (!tu || typeof tu !== "object") continue;
    const t = tu as { name?: string; arguments?: unknown };
    if (t.name !== "report_blocked" || !t.arguments || typeof t.arguments !== "object") continue;
    const a = t.arguments as Record<string, unknown>;
    const raw = Array.isArray(a.conflicts) ? a.conflicts : [];
    let took = 0;
    // A readable entry this extraction can no longer take is still a readable entry the child named, so it
    // counts towards the total the cap is measured against — otherwise a call whose usable entries all fell
    // past the bound would report nothing at all.
    const usable = raw.filter(isBlockedRow);
    total += usable.length;
    // The cap is the EXTRACTION's, so a call is taken up to the room the record still has.
    for (const e of usable.slice(0, MAX_ENTRIES - rows.length)) {
      rows.push({ path: e.path.trim(), reason: clipReason(e.reason) });
      took++;
    }
    // A call that lost every entry is not an empty report: `rows: []` would read as "the child named
    // nothing", a verdict it did not give. It is counted as a malformed call.
    if (took === 0) skipped++;
  }
  // A child may call the tool more than once; the entries it named past the record's bound are not
  // evidence the run can hold, and silence about them would read as "the child named nothing more".
  skipped += Math.max(0, total - MAX_ENTRIES);
  return { rows, skipped };
}
