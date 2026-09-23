/**
 * work-driver-scope-fence — #814: re-export of the shared type for a
 * structured develop-scope-fence violation.
 *
 * The canonical type is `FenceViolation` in workflow-state-schema.ts (it
 * is referenced by `PipelineState.verifyEvidence.fenceViolations`). This
 * module re-exports it under the name `FenceViolationRecord` so the gate
 * module (work-driver-scope-fanout.ts) and the verify-develop caller can
 * import it without a circular dependency on the schema file.
 *
 * Both `sibling-declared` and `issue-fenced` records BLOCK the develop
 * gate (a failure string reaches `failures`); `undeclared` (computed
 * separately from the changed set) WARNS only.
 */
export type { FenceViolation as FenceViolationRecord } from "./workflow-state-schema.ts";
