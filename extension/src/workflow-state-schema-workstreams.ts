/**
 * workflow-state-schema-workstreams — #679: the workstream shape + the
 * `workstreamBaseShas` field, split out of workflow-state-schema.ts (500-line
 * gate). These are the per-workstream fields added by #679 (case 2(a)/2(b)/3):
 *
 * - `Workstream` — the value type of `PipelineState.workstreams`, extended
 *   with `dependsOn?: string[]` (case 2(a)) and `integrationTest?: string`
 *   (case 3).
 * - `workstreamBaseShas` — the per-workstream effective base map (case 2(b)),
 *   declared here as a named type so the PipelineState field can reference
 *   it without inlining the long comment.
 *
 * Re-exported from workflow-state-schema.ts so existing importers keep their
 * paths unchanged.
 */

/**
 * #679 — the workstream value type. Extends the pre-#679 shape
 * `{ id, scope, paths, outOfScope }` with two optional fields:
 *
 * - `dependsOn` — case 2(a). Workstream ids this one builds on, parsed
 *   from a `- depends-on: <id>` line. Absent (or empty) means independent.
 *   Optional: state files written before #679 load unchanged.
 * - `integrationTest` — case 3. Path of the consolidated-tree test this
 *   workstream declares for the pair it depends on. A PLAN-QUALITY
 *   DECLARATION ONLY: the develop step does not execute it (that is #669's
 *   territory) — it exists so the plan gate can require integration
 *   coverage when two workstreams are interdependent through different
 *   files.
 */
export interface Workstream {
  id: string;
  scope: string;
  paths: string[];
  outOfScope: string[];
  /** #679 — case 2(a). Workstream ids this one builds on (see above). */
  dependsOn?: string[];
  /** #679 — case 3. Consolidated-tree test path (see above). */
  integrationTest?: string;
}

/**
 * #679 — the per-workstream EFFECTIVE BASE: the commit the workstream's
 * worktree was (or will be) created from. Every workstream defaults to the
 * global baseSha; a dependent workstream (one with `dependsOn`) gets its
 * dependency's post-commit SHA when its worktree is created in the develop
 * step (case 2(b) — deferred worktree creation). Both `applySafetyNet` and
 * `verifyDevelopOutcome` resolve the per-workstream base from this map
 * BEFORE their `validBaseSha` / `isValidSha` checks, because a dependent
 * workstream compared against the GLOBAL baseSha would miscount its commits.
 * Optional: state files written before #679 load unchanged (readers fall
 * back to the global baseSha).
 */
export type WorkstreamBaseShas = Record<string, string>;
