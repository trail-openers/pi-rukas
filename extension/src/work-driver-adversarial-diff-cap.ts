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
 *
 * Private on purpose: it is the reading behind {@link isDiffUnreadableOutcome},
 * which is the ONE predicate the park and router sites call. The sites that
 * once read the event directly read the outcome instead, so an exported second
 * predicate was a second way to ask the same question — and the pair drifted
 * before this module existed.
 */
function isDiffUnreadableDispatch(e: FailedDispatch | undefined): boolean {
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
 * The reason one read failure reports — the ONLY producer of the sentence, and
 * the place its text is BOUNDED. `redactClip` is the same scrub the provider
 * park's evidence gets (`work-driver-provider-park.ts::providerParkEvidence`):
 * this string is git/child-authored text that the outcome carries into the
 * durable state file and onto the handoff, so it is scrubbed at the PRODUCER.
 * That is what lets the cap helper trust what it was handed, and what makes the
 * outcome, its dispatch event and the cap's evidence carry the SAME bounded
 * text rather than three lengths of it.
 */
export function adversarialDiffReadReason(id: string, cwd: string, reason: string): string {
  const head = `adversarial could not read the diff for workstream ${id} at ${cwd || "(no worktree)"}: `;
  // The prefix is this module's own text, so only the git half needs bounding —
  // and the whole line still lands inside the taxonomy's budget.
  return head + redactClip(reason, FAILURE_REASON_CHARS - head.length);
}

/**
 * The cap-hit that parks an adversarial step whose diff the driver could not
 * read. `reason` is the failing outcome's own account of the read
 * (`AdversarialOutcome.errorTail` / `rejectionText`), which is the only version
 * that describes THIS workstream's failure — normally the producer's already
 * bounded text, and re-bounded here because a router caller reads `errorTail`
 * off an event it did not write.
 *
 * The evidence is ALWAYS populated. A park with no evidence prints the bare cap
 * name and sends the operator nowhere, so a missing or blank reason becomes a
 * fixed sentence rather than a gap.
 */
export function adversarialDiffUnreadableCapHit(
  reason: string | undefined,
  reviewRound: number,
): Extract<WorkEvent, { kind: "cap-hit" }> {
  const text = reason?.trim() || "the diff read failed with no reason reported";
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap: "adversarial-diff-unreadable",
    reviewRound,
    nextStep: "handoff",
    evidence: redactClip(text, FAILURE_REASON_CHARS),
  };
}
