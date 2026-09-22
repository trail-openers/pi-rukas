/**
 * #741 — the converge gate's per-deliverable classification record type,
 * split from workflow-state-schema.ts (AGENTS.md §12 file-size limit).
 * Re-exported from workflow-state-schema.ts so existing importers keep
 * their paths.
 */
export interface ConvergeEvidence {
  /** Epoch ms when the gate classified the end-of-develop diff. */
  at: number;
  deliverables: Array<{
    id: string;
    /** Matches work-driver-converge.ts's `DeliverableStatus` literal union. */
    status: "implemented" | "partial" | "absent" | "unmeasurable" | "no-diff";
    reason: string;
  }>;
}
