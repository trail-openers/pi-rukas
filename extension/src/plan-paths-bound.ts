/**
 * plan-paths-bound — what the driver does with a planner's `paths` list
 * (#1756 part b): keep EVERY declared path, and say out loud when the prompt
 * cannot show them all.
 *
 * The defect (five field parks, all `plan-spec-mismatch`): the schema
 * carried `maxItems: WORKSTREAM_LIST_MAX` (50) on `paths`, so a 51st declared
 * path failed Pi's schema check and the WHOLE `report_workstream` call was
 * refused — "paths: must not have more than 50 items". A workstream that names
 * its files was punished for naming too many of them, and the planner's usual
 * recovery was to re-report with a shorter list, which made the omitted files
 * unauthorised for every scope gate downstream.
 *
 * WHY `paths` IS BOUNDED DIFFERENTLY FROM `outOfScope` (#1744's template, and
 * the reason the two are NOT merged into one module): `outOfScope` is free text
 * the developer reads, so clipping it costs a sentence. Every scope gate reads
 * `ws.paths` as THE AUTHORISED SET — the fanout denominator
 * (`work-driver-scope-fanout.ts`), the path-claims registry
 * (`work-driver-path-claims.ts`), `findPathCollisions`, `verifyConsolidation`,
 * the fix-pass anchors and the deferred-protected fence. A dropped path would
 * silently become unauthorised, so THIS bound never drops one: it dedupes, it
 * COUNTS what a prompt cannot show, and the count is what travels
 * (`Workstream.pathsDropped`). The schema's abuse ceiling
 * (`WORKSTREAM_PATH_INPUT_LIST_MAX`, 500) is the only thing that still refuses
 * a call, and it is there to stop a runaway reply, not to bound a plan.
 *
 * Structural template: `plan-fence-bound.ts`. Kept separate on purpose — the
 * two lists are different kinds of thing, they refuse differently, and merging
 * them would make one field's rule read as the other's.
 *
 * The dependency runs ONE way: this module imports the constants it enforces
 * from `plan-workstream-schema.ts` (never the other way round), so the plan
 * child's companion graph stays the schema plus `plan-path-shape.ts`.
 */

import { quotedPaths } from "./plan-path-shape.ts";
import { WORKSTREAM_LIST_MAX, WORKSTREAM_PATH_INPUT_LIST_MAX } from "./plan-workstream-schema.ts";
import { normaliseDeclaredPath } from "./work-driver-declared-path.ts";

/**
 * What one pass of the paths bound did. `dropped` is a DISPLAY count, never a
 * removal: it is how many declared paths the develop prompt will not print, and
 * the only thing it may ever influence is a line of prose.
 */
export interface BoundPaths {
  /** Every declared path, deduped, in the planner's order (raw strings). */
  paths: string[];
  /** Declared paths beyond the first `WORKSTREAM_LIST_MAX` — display only. */
  dropped: number;
  /** Entries that collapsed onto a path the list already held. */
  duplicate: number;
}

/**
 * The planner's `paths` as the driver stores them: ALL of them, deduped on the
 * NORMALISED text (so `src/a.ts (new)` and `src/a.ts` are one entry, the same
 * identity `findPathCollisions` uses) while the RAW string is what is stored —
 * the raw form is what `quotedPaths` renders and what the consolidation
 * normaliser strips, so storing a normalised copy would lose the annotation the
 * later comparisons already tolerate.
 *
 * Dedup BEFORE the display cut, not after: a list of 80 with 20 duplicates
 * authorises 60 files, and the fanout denominator must read 60, not 80.
 *
 * Pure: the caller owns the trace line and the `pathsDropped` field, so the
 * fold can carry its own count and one call emits one warning.
 */
export function boundPaths(paths: readonly string[]): BoundPaths {
  const kept: string[] = [];
  const seen = new Set<string>();
  let duplicate = 0;
  for (const entry of paths) {
    const key = normaliseDeclaredPath(entry);
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    kept.push(entry);
  }
  return {
    paths: kept,
    dropped: Math.max(0, kept.length - WORKSTREAM_LIST_MAX),
    duplicate,
  };
}

/**
 * The one trace line a bounded `paths` list produces, shared by every paths
 * writer so they cannot say the same event in different words. It says plainly
 * that nothing was removed: an operator who reads "dropped" here must not
 * conclude a file lost its authorisation, because that is exactly the claim the
 * #1744 fence line makes about a fence entry.
 */
export function pathsBoundNotice(subject: string, b: BoundPaths): string {
  const parts = [
    `${b.paths.length} kept`,
    `${b.duplicate} ${b.duplicate === 1 ? "duplicate" : "duplicates"} collapsed`,
    `${b.dropped} ${b.dropped === 1 ? "path" : "paths"} past the ${WORKSTREAM_LIST_MAX}-path prompt display (all still in scope)`,
  ];
  return `work-driver: ${subject} paths bounded — ${parts.join(", ")} (schema ceiling: ${WORKSTREAM_PATH_INPUT_LIST_MAX})`;
}

/**
 * The `In-scope files:` line for a prompt: the first `WORKSTREAM_LIST_MAX`
 * quoted, and a pointer to the plan list when the workstream declared more.
 *
 * With nothing to hide the output is byte-identical to `quotedPaths(paths)`,
 * which is what keeps every existing prompt assertion working. The tail never
 * removes authorisation — the gates read `ws.paths`, not this line — so it
 * tells the developer the rest exists and where to read it, instead of letting
 * a 51st file look like an invention.
 */
export function inScopeFilesLine(paths: readonly string[], dropped: number): string {
  const shown = dropped > 0 ? paths.slice(0, WORKSTREAM_LIST_MAX) : [...paths];
  const listed = quotedPaths(shown);
  if (dropped <= 0) return listed;
  return `${listed} (+${dropped} more declared paths in scope; read the plan list before adding new files)`;
}
