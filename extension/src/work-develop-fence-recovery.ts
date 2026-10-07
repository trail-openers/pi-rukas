/**
 * work-develop-fence-recovery — the develop step's fence merge-and-retry:
 * the surviving record-level helpers (the #1005 flow's vocabulary).
 *
 * The #849 recovery flow (re-dispatch of the violator alone) was replaced
 * by the #1005 merge-and-retry (work-develop-fence-merge.ts +
 * work-develop-fence-merge-retry.ts), which MERGES the coupled workstreams
 * instead of re-running the same split. The dead #849 machinery (the cycle
 * check, the dependsOn injection, the recovery prompt, the discard
 * precondition park) was deleted with its flow; this module keeps what the
 * #1005 flow still uses:
 *
 *   - FENCE_VIOLATION_CAP — the shared cap literal (one source),
 *   - siblingDeclaredViolators — the violator discriminator (the merge
 *     fires ONLY on `sibling-declared` records; `issue-fenced` still
 *     blocks as today, `undeclared` never triggers the merge),
 *   - fenceViolationCapHit — the cap-hit event builder (the merge's
 *     second-failure handoff and its aborts build the cap here so the cap
 *     name stays single-sourced).
 */
import type { FenceViolationRecord } from "./work-driver-scope-fence.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

// #849/#1005 — typed from the `cap` literal union (workflow-state-events-caps.ts)
// so the cap name has one source: a rename there breaks here, not silently.
export const FENCE_VIOLATION_CAP = "fence-violation:develop" as const satisfies WorkCapLiteral;

/**
 * #849/#1005 — the workstream ids with a BLOCKING sibling-declared fence
 * record (the merge candidates). `issue-fenced` and `undeclared` records
 * are excluded: they block/warn exactly as before, never merge.
 */
export function siblingDeclaredViolators(fenceViolations: FenceViolationRecord[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of fenceViolations) {
    if (v.kind !== "sibling-declared") continue;
    if (seen.has(v.workstreamId)) continue;
    seen.add(v.workstreamId);
    ids.push(v.workstreamId);
  }
  return ids;
}

/**
 * #849/#1005 — the cap-hit event for a fence park (a second violation
 * after the merge-and-retry, or a merge-and-retry abort). The caller
 * composes `evidence` to name the MERGE (the #1005 acceptance criterion:
 * both halves, both attempts, plus the discarded SHA from the
 * `fence-recovery-started` event).
 */
export function fenceViolationCapHit(
  reviewRound: number,
  evidence: string,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap: FENCE_VIOLATION_CAP,
    reviewRound,
    nextStep: "handoff",
    evidence,
  };
}
