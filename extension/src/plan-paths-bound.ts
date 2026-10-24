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

import { neutraliseFenceEntry } from "./plan-fence-render.ts";
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
 * The rule in one line: dedup happens BEFORE anything reads the list. Every
 * consumer — the fanout denominator, the path-claims registry, the collision
 * scan, the consolidation audit and the prompts — reads the SAME deduped array,
 * so a list of 80 with 20 duplicates authorises 60 files everywhere, and no
 * reader has to dedupe for itself (or fail to) to get a consistent answer.
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
  // One normalisation per DISTINCT raw string (#1756 round 2): a fold re-runs
  // this over a union that is mostly the entries it already saw, and
  // `normaliseDeclaredPath` is a regex pass over each of them. The memo lives
  // for the duration of one call, so a repeated raw entry pays the normaliser
  // once and the dedup rule itself is untouched.
  const keys = new Map<string, string>();
  let duplicate = 0;
  for (const entry of paths) {
    let key = keys.get(entry);
    if (key === undefined) {
      key = normaliseDeclaredPath(entry);
      keys.set(entry, key);
    }
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
 * The tally a `paths` writer reports: how many entries the list NOW holds, and
 * how many collapsed onto them. Deliberately not `BoundPaths` — a fold pass
 * accumulates the union across its folds rather than re-deriving it, so it
 * carries these two numbers and no array.
 */
export interface PathsTally {
  /** Entries the bounded list keeps. */
  kept: number;
  /** Entries that collapsed onto a path the list already held. */
  duplicate: number;
}

/**
 * The one trace line a bounded `paths` list produces, shared by every paths
 * writer so they cannot say the same event in different words. It says plainly
 * that nothing was removed: an operator who reads "dropped" here must not
 * conclude a file lost its authorisation, because that is exactly the claim the
 * #1744 fence line makes about a fence entry.
 *
 * `kept` is the REAL length of the bounded list, whatever pass produced it: a
 * fold that reported `0 kept` read as an empty workstream, which is the one
 * thing the line must never say — so every fold pass measures the union it
 * actually built. `subject` is driver prose, but it carries
 * planner-written text (a workstream id, a port reference) and reaches the same
 * log channel the fence bound writes to, so it goes through the fence's own
 * neutraliser — one line, no backticks, no forged clip marker.
 */
export function pathsBoundNotice(subject: string, tally: PathsTally): string {
  const parts = [
    `${tally.kept} kept`,
    `${tally.duplicate} ${tally.duplicate === 1 ? "duplicate" : "duplicates"} collapsed`,
  ];
  return `work-driver: ${neutraliseFenceEntry(subject)} paths bounded — ${parts.join(", ")} (schema ceiling: ${WORKSTREAM_PATH_INPUT_LIST_MAX})`;
}
