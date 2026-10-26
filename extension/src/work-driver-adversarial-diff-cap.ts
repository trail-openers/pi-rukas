/**
 * work-driver-adversarial-diff-cap — #1634: the ONE place that builds the
 * `adversarial-diff-unreadable` cap-hit, plus the ONE predicate that decides
 * whether an event or an outcome describes a diff the driver could not READ.
 *
 * Two things lived in four places before this module, and both drifted.
 *
 * The cap-hit: the gate reaches this park from four sites (the fan-out's
 * `parkedInfra` shortfall, the N=1 re-entry branch, the final-failure branch,
 * and the step router's dispatch-failure path). When each one assembled its own
 * event the evidence silently diverged — three read
 * `pipelineState.adversarialDiffError`, a field a concurrent sibling's read
 * mutates, and one read the failing outcome's own `reason` — so the same park
 * printed different text depending on which workstream lost the race. One
 * helper now, and its evidence is always the failing outcome's own reason,
 * redacted and clipped through the taxonomy's budget.
 *
 * The predicate: the router recognised the read by matching a PROSE PREFIX of
 * `errorTail`. That string is owned by the reason renderer
 * (`adversarialDiffReadReason`); a reworded reason silently lost the cap, and
 * a cycle whose diff nobody read parked under `step-failed:adversarial` with
 * the reviewer blamed. Both readings below are structural: the `diffUnreadable`
 * field stamped at the one site that synthesises the failure
 * (`work-driver-adversarial-fanout-diff.ts`).
 */

import { redactClip } from "./decision-log.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import { FAILURE_REASON_CHARS } from "./work-driver-failure-taxonomy.ts";
import type { WorkEvent } from "./workflow-state.ts";

/** The failure-event shape this module reads (the non-provider member). */
type FailedDispatch = Extract<WorkEvent, { kind: "dispatch-failed" }>;

/**
 * Did the DRIVER fail to read this workstream's diff (as opposed to the
 * reviewer failing to run)? Reads the structural marker only — never prose.
 */
export function isDiffUnreadableDispatch(e: FailedDispatch | undefined): boolean {
  return e?.diffUnreadable === true;
}

/**
 * The same question about an outcome. An outcome whose read failed is
 * `infra: true` with no verdict, so it must never be aggregated as a
 * rejection — and `skipped` is excluded explicitly: a genuinely empty diff is
 * a read that SUCCEEDED (#286's skip is an approval, so the two must not
 * converge on one predicate).
 */
export function isDiffUnreadableOutcome(o: AdversarialOutcome): boolean {
  return o.diffUnreadable === true && !o.ok && !o.skipped;
}

/**
 * The reason one read failure reports, from the git error. The ONLY producer of
 * this sentence — the predicate no longer matches it, so renaming it is safe,
 * and both the outcome and its dispatch event carry the same string.
 */
export function adversarialDiffReadReason(id: string, cwd: string, reason: string): string {
  return `adversarial could not read the diff for workstream ${id} at ${cwd || "(no worktree)"}: ${reason}`;
}

/**
 * The cap-hit that parks an adversarial step whose diff the driver could not
 * read. `reason` is the failing outcome's own account of the read
 * (`AdversarialOutcome.errorTail` / `rejectionText`), which is the only version
 * that describes THIS workstream's failure.
 *
 * `redactClip` is the same scrub the provider park's evidence gets
 * (`work-driver-provider-park.ts::providerParkEvidence`): this string is
 * git/child-authored text that lands in the durable state file and on the
 * handoff, so it is scrubbed before it is written, not only at render. The
 * bound is the taxonomy's own so the clip stays one number.
 */
export function adversarialDiffUnreadableCapHit(
  reason: string | undefined,
  reviewRound: number,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap: "adversarial-diff-unreadable",
    reviewRound,
    nextStep: "handoff",
    ...(reason?.trim() ? { evidence: redactClip(reason, FAILURE_REASON_CHARS) } : {}),
  };
}

/**
 * The reason a park's evidence carries, from whichever event ended the step.
 * The read's own git error lives on `errorTail` of the synthesised
 * `dispatch-failed`; the provider member keeps its own renderer.
 */
export function adversarialDiffUnreadableEvidence(
  tail: FailedDispatch | undefined,
): string | undefined {
  return isDiffUnreadableDispatch(tail) ? tail?.errorTail : undefined;
}
