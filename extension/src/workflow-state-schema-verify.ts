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

/**
 * Which writer raised a `verify-failed:<step>` park. The explanation routes on
 * this field, not on the text of the failure strings. Written by each writer;
 * absent on state files from before it existed, which render as the outcome
 * gate did.
 */
export type VerifyEvidenceOrigin = "outcome-gate" | "fix-pass" | "pr-not-open";

/**
 * #1392 D5 — the RAW output tail behind one consolidated-verify run, stored
 * STRUCTURALLY so the handoff surfaces can print the output itself instead of
 * only naming a scratch path. Cycles 54 and 60 both parked with nothing but
 * `Raw output: <path>` — a path inside the cycle's scratch dir, which is not
 * on the issue and is gone whenever the workspace is cleaned, so the operator
 * reading the comment could not see what the gate printed.
 *
 * `tail` is bounded by the caller before it is stored (the same
 * `extractAttributedTail` window the evidence uses). It is UNTRUSTED content —
 * whatever the project's verify command printed — so the renderers put it in a
 * fenced block computed from its own backtick run, never inline.
 *
 * Absent on every state file written before this field; the renderers then
 * print nothing extra (a park with no captured tail still says so plainly).
 */
export interface VerifyOutputTail {
  /** Which verify run this tail came from — the same value `verifyEvidence.step` carries. */
  step: string;
  /** The raw project gate output this was taken from (its command name). */
  command?: string;
  /** The bounded, redacted tail. */
  tail: string;
  /** True when the tail starts at a `FAILED:` marker (sound attribution). */
  attributed?: boolean;
  /** Epoch ms when the tail was captured. */
  at: number;
}
