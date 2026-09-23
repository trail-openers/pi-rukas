/**
 * workflow-state-schema-verify — the `verifyEvidence`-shaped types
 * (PipelineState field declared in workflow-state-schema.ts; this file is the
 * "verify-evidence home" for the shapes that field references).
 *
 * Currently hosts `FenceViolation` — the #814 develop-scope-fence record
 * (previously declared in workflow-state-schema-workstreams.ts, which is the
 * #679 workstream-shape home and has no business carrying a verify-evidence
 * type). Re-exported from workflow-state-schema.ts so existing importers
 * keep their paths unchanged.
 */

/**
 * #814 — a single structured develop-scope-fence violation record.
 * Discriminated union on `kind`:
 * - `sibling-declared` (BLOCKING — a failure string reaches
 *   `verifyEvidence.failures`): the file is in ANOTHER workstream's
 *   `paths` — `declaredById` names that sibling; a guaranteed
 *   consolidation collision.
 * - `issue-fenced` (BLOCKING): the file is in the workstream's own
 *   `outOfScope` fence but declared by no sibling — an issue-level
 *   exclusion; every N=1 fence hit is this.
 * - `undeclared` (computed separately from the changed set; WARNS — a
 *   note plus this record, never a failure): a touched file in NO
 *   workstream's `paths` AND not in the workstream's own fence.
 */
export type FenceViolation =
  | {
      kind: "sibling-declared";
      /** The violating workstream. */
      workstreamId: string;
      /** The touched file. */
      file: string;
      /** The workstream that declared the file in its own paths. */
      declaredById: string;
    }
  | {
      kind: "issue-fenced";
      workstreamId: string;
      file: string;
    }
  | {
      kind: "undeclared";
      workstreamId: string;
      file: string;
    };
