/**
 * #1362 — the `.pi/dirty-root-exempt` provenance record, and its validator.
 * Split out of workflow-state-schema.ts / workflow-state-validate.ts
 * (AGENTS.md §12 file-size limit), the same seam #540 used for
 * `ConsolidationVerdict`.
 *
 * `DirtyRootExemptBaseline` is the provenance record the restore claim reads to
 * tell a cycle's own `??` output apart from a tool file that was already sitting
 * in an exempt prefix when the cycle started. A post-reset `??` cannot answer
 * that — the abort path's mixed reset turns the cycle's staged-new files into
 * `??`, the same code a stray carries — so the branch step snapshots the exempt
 * paths that were untracked at cycle start, and the claim spares a path only
 * when it appears here. Absent means NOTHING is claim-exempt (fail-closed):
 * a claim that over-names is a dismissible false alarm; one that under-names
 * says "verified restored" over the cycle's own work.
 *
 * Written once by the branch step and never recomputed — a later snapshot would
 * bless the cycle's output as pre-existing. Producers and the fail-closed bound
 * (the 500-path cap) live in `work-driver-dirty-root-exempt.ts`.
 */

/** `pipelineState.dirtyRootExemptBaseline`: repo-relative untracked paths
 *   under an exempt prefix, as they stood when the cycle began. Sorted, unique,
 *   at most 500 entries (the producer records nothing past the cap rather than
 *   a truncated list). */
export type DirtyRootExemptBaseline = string[];

/**
 * #533's rule, applied to `dirtyRootExemptBaseline`: the cast in `readState` is
 * the only runtime gate, so a partial or hand-edited value must not reach a
 * restore. A value that is not a string array would either throw inside the
 * claim predicate mid-restore or read as "nothing matches" and quietly spare the
 * cycle's own output. Returns the findings for `validateDiscriminants` to
 * surface; `[]` when the field is absent — every pre-#1362 state file, and every
 * cycle with no exemption list, must still resume.
 */
export function dirtyRootExemptBaselineFindings(baseline: unknown): string[] {
  if (baseline === undefined) return [];
  if (!Array.isArray(baseline)) {
    return ["pipelineState.dirtyRootExemptBaseline is not an array"];
  }
  return baseline.some((v) => typeof v !== "string")
    ? ["pipelineState.dirtyRootExemptBaseline contains a non-string entry"]
    : [];
}
