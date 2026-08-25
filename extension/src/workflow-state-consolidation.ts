/**
 * #540 — consolidation-gate types + reader-facing adapters. Split from
 * workflow-state-schema.ts (AGENTS.md §12 file-size limit).
 *
 * `ConsolidationVerdict` is the per-workstream subsumption-aware verdict
 * produced by `verifyConsolidation` (work-driver-verify.ts).
 * `IncompleteConsolidation` is the persisted shape of
 * `pipelineState.incompleteConsolidation` — extended over the pre-#540
 * `Array<{ id, paths }>` shape to record BOTH sides of the gate
 * (missing verdicts + `filesPresent`).
 *
 * The reader-facing adapters (`missingWorkstreamsFromConsolidation`,
 * `filesPresentFromConsolidation`) live here rather than next to the
 * field so the two renderers never index the union directly. The #533
 * canary (workflow-state-validate.ts `validateDiscriminants`) validates
 * the `status` discriminant, so no field is smuggled.
 */

/**
 * #540 — the subsumption-aware consolidation verdict of a single workstream
 * from `verifyConsolidation` (work-driver-verify.ts). A workstream is
 * `complete` when EVERY declared path is in the committed diff OR is
 * declared by a sibling whose ENTIRE declared path set is present (full-set
 * subsumption — a partial sibling cannot cover another workstream's path).
 * `uncovered` is the same, with `uncoveredPaths` naming exactly which
 * declared paths the rule could not cover. `unverifiable` is the honest
 * third state: no declared paths (the planner gave nothing to verify) or the
 * diff read itself failed (best-effort — a transient git issue must not
 * false-alarm the whole cycle).
 */
export type ConsolidationVerdict =
  | { id: string; status: "complete" }
  | { id: string; status: "uncovered"; uncoveredPaths: string[] }
  | { id: string; status: "unverifiable"; reason: string };

/**
 * #540 — `pipelineState.incompleteConsolidation`. Extended (not replaced)
 * over the pre-#540 shape `Array<{ id, paths }>`: it now records BOTH sides
 * of the gate — the per-workstream verdicts (missing AND covered) AND
 * `filesPresent`, the committed file list the handoff renders so the
 * operator sees what actually shipped. State files written before this
 * change carry the bare array; the reader adapters tolerate both. New
 * writes always use this shape. `validateDiscriminants` validates the
 * `status` discriminant rather than smuggled ad-hoc fields (#533's rule).
 */
export interface IncompleteConsolidation {
  /** Per-workstream verdicts — only workstreams the gate could NOT verify
   *   as covered (uncovered) or could not verify at all (unverifiable).
   *   Complete workstreams are implied by the rest of the workstream map.
   *   Legacy entries in state files (pre-#540 shape) may lack `status`/
   *   `uncoveredPaths`/`reason` — readers must not be written against
   *   that; see `missingWorkstreamsFromConsolidation` for the tolerant
   *   reader adapter. */
  verdicts: ConsolidationVerdict[];
  /** The committed file list (`git diff --name-only origin/<base>..HEAD`).
   *   Absent for state files written by the pre-#540 writer (legacy
   *   `paths`-only shape, no `filesPresent` key at all). */
  filesPresent?: string[];
}

/**
 * #540 — the shape the READER adapters tolerate when indexing
 * `incompleteConsolidation`'s verdicts: the current `ConsolidationVerdict[]`
 * AND the legacy pre-#540 entry (no `status`, just `{ id, paths }`), which
 * persisted state files still carry. Writers must NOT use this — new
 * writes are `ConsolidationVerdict[]` only (see `IncompleteConsolidation.verdicts`).
 */
type TolerantConsolidationEntry =
  | ConsolidationVerdict
  | { id: string; paths: string[]; status?: undefined };

/**
 * #540 — read `incompleteConsolidation` as a flat list of missing
 * workstreams, tolerating BOTH the legacy pre-#540 shape (a bare
 * `Array<{ id, paths }>` on the field) and the current
 * `IncompleteConsolidation` shape. Legacy entries map to `{ id, paths }`;
 * an `uncovered` verdict maps to `{ id, paths: uncoveredPaths }`.
 * `unverifiable` and `complete` verdicts are NOT "missing" — the gate
 * fires on `uncovered` only (`unverifiable` is a note, not a failure).
 *
 * This is the ONLY reader-facing adapter for the field: renderers call
 * it instead of indexing the field directly, so the two shapes are
 * handled in one place. Returns `[]` when the field is absent or the
 * recorded verdicts name no uncovered workstream.
 */
export function missingWorkstreamsFromConsolidation(
  ic: IncompleteConsolidation | Array<TolerantConsolidationEntry> | undefined,
): Array<{ id: string; paths: string[] }> {
  if (ic === undefined || ic === null) return [];
  if (Array.isArray(ic)) {
    return ic
      .filter((e): e is { id: string; paths: string[] } => "paths" in e && Array.isArray(e.paths))
      .map((e) => ({ id: e.id, paths: e.paths }));
  }
  const out: Array<{ id: string; paths: string[] }> = [];
  for (const v of ic.verdicts) {
    if (v.status === "uncovered") {
      out.push({ id: v.id, paths: v.uncoveredPaths });
    }
  }
  return out;
}

/**
 * #540 — read `incompleteConsolidation`'s `filesPresent` (the committed
 * file list) as a string array; `[]` for absent fields and for state files
 * in the legacy pre-#540 array shape (which recorded no file list).
 */
export function filesPresentFromConsolidation(
  ic: IncompleteConsolidation | Array<TolerantConsolidationEntry> | undefined,
): string[] {
  if (ic === undefined || ic === null || Array.isArray(ic)) return [];
  return ic.filesPresent ?? [];
}
