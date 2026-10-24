/**
 * plan-paths-bound — what the driver does with a planner's `paths` list
 * (#1756 part b): keep EVERY declared path, and print every one of them.
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
 * silently become unauthorised, so THIS bound never drops one: it dedupes and
 * it prints. There is no display truncation — the prompts print the whole
 * authorised set, because a developer cannot stay inside a list it never saw,
 * and a notice pointing at a plan list it cannot read is not a bound. Size is
 * bounded ONCE, by the schema's abuse ceiling (`WORKSTREAM_PATH_INPUT_LIST_MAX`,
 * 500), which is the only thing that still refuses a call and is there to stop
 * a runaway reply, not to bound a plan.
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
import { WORKSTREAM_PATH_INPUT_LIST_MAX } from "./plan-workstream-schema.ts";
import { normaliseDeclaredPath } from "./work-driver-declared-path.ts";

/**
 * What one pass of the paths bound did. Nothing is removed, so the only thing
 * worth reporting is how many entries collapsed onto a file the list already
 * held.
 */
export interface BoundPaths {
  /** Every declared path, deduped, in the planner's order (raw strings). */
  paths: string[];
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
 * Dedup keys on `normaliseDeclaredPath`, the SAME identity every scope gate
 * uses: `**src/b.ts**` and `src/b.ts` are one file to the gates, so they are
 * one entry here — deduping on the raw text would authorise the same file
 * twice and inflate the fanout denominator.
 *
 * Pure: the caller owns the trace line, so the fold can aggregate its own
 * pass and one pass emits one warning.
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
  return { paths: kept, duplicate };
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
  ];
  return `work-driver: ${subject} paths bounded — ${parts.join(", ")} (schema ceiling: ${WORKSTREAM_PATH_INPUT_LIST_MAX})`;
}

/**
 * The `In-scope files:` line for a prompt: EVERY declared path, quoted. The
 * schema ceiling (500) is what bounds the line; a developer must see its whole
 * authorised set, since the scope gates judge it against all of them.
 */
export function inScopeFilesLine(paths: readonly string[]): string {
  return quotedPaths(paths);
}
