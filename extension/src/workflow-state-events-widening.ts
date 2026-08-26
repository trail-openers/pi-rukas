/**
 * /work workflow state — widening-scan event type.
 *
 * The `widening-scan` member of the `WorkEvent` union, split out of
 * `workflow-state-events.ts` (AGENTS.md §12 file-size limit — the #543
 * cap-string + role additions pushed the composed union past the 500-line
 * gate). The same seam pattern as workflow-state-events-memory.ts: the
 * fragment is composed into the closed union by name, so `nextStep()` and
 * the schema validator see exactly the same shape.
 */

import type { WideningFinding } from "./invariant-scan.ts";

export type WideningScanEvent = {
  /**
   * Issue #279 — type-widening scan results.
   *
   * The deterministic scanner (invariant-scan.ts) fires before
   * lens-review, capturing compiler-enforced invariants being
   * removed or weakened. Findings are injected into the lens
   * context with framing "the ARCHITECTURE lens must answer: what
   * invariant did this widening remove, and what now guarantees it?"
   *
   * Routes-only — does not fail the cycle. The precision of these
   * patterns is measured via fixture tests; the ARCHITECTURE lens
   * decides whether each finding is a real problem or benign.
   */
  kind: "widening-scan";
  at: number;
  /** Findings from the scan (empty list = no widening detected). */
  findings: WideningFinding[];
};
