/**
 * work-driver-merged-hold — the `merged` step's "do not merge" state, split out of
 * work-driver-merged.ts (AGENTS.md §12: split along a natural seam rather than
 * compress a file at the 500-line cap).
 *
 * The whole of the merge gate's refusal lives here: the authority verdict, the CI
 * evidence, the round-cap disclosure flag, and the #1533 head refusal's two SHAs
 * all land in one `mergeHold` record, and every one of them has to be copied into
 * that record or the handoff downstream loses the reason the cycle parked. That is
 * precisely the shape of bug this file exists to prevent: with the construction
 * inline in `runMerged` it grew a fifth field, then a sixth, each one added where
 * the reader could not see which of the gate's four decisions had been written down
 * and which had been left out.
 *
 * The fields are all OPTIONAL on purpose, and the optionality is load-bearing:
 * `explainMergeHold` distinguishes "the gate did not run" from "the gate ran and
 * said X" by whether a field is PRESENT, so writing `undefined` is not the same as
 * omitting a key. Every spread below is therefore a conditional spread rather than
 * a plain assignment, and a refactor that "simplifies" them into plain keys would
 * turn silent absences into asserted ones — a handoff would then claim the head
 * check reported a reason when it reported nothing.
 */

import type { MergeAuthority } from "./work-driver-merge-authority.ts";
import type { MergeEvidence } from "./work-driver-merge-evidence.ts";
import type { HeadCheck } from "./work-driver-merged-head.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The `merged`-step state for a cycle that must NOT merge: same shape the caller
 * holds, with `currentStep` at `merged` and a `mergeHold` recording why.
 *
 * `routedRoundCap` marks the #973 shape — a cycle that reached the merge step with
 * unresolved lens findings carried forward under the round cap. It is passed in
 * rather than re-derived here so the caller's single evaluation of
 * `heldByUnresolvedReview` is the one the hold records; two derivations that could
 * disagree would be a hold that says "nothing outstanding" beside a merge that was
 * held for outstanding findings.
 */
export function heldForMissingApproval(
  state: WorkState,
  authority: MergeAuthority,
  evidence: MergeEvidence | undefined,
  routedRoundCap: boolean,
  headCheck: HeadCheck | undefined,
): WorkState {
  const refusal = headCheck && !headCheck.ok ? headCheck.refusal : undefined;
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "merged",
      mergeHold: {
        authorityGranted: authority.granted,
        authoritySource: authority.source,
        ...(authority.quote ? { authorityQuote: authority.quote } : {}),
        ...(evidence?.reason ? { evidenceReason: evidence.reason } : {}),
        ...(evidence?.failureKind ? { evidenceFailureKind: evidence.failureKind } : {}),
        ...(evidence?.inconclusive?.length ? { inconclusive: evidence.inconclusive } : {}),
        ...(routedRoundCap ? { unresolvedReviewFindings: true } : {}),
        // #1533 — the two SHAs a head refusal names, structured rather than left
        // in prose: the queue's park reason and the handoff renderers read them off
        // the state file.
        ...(refusal?.reviewedHead ? { reviewedHead: refusal.reviewedHead } : {}),
        ...(refusal?.foundHead ? { headAtMerge: refusal.foundHead } : {}),
        ...(refusal?.reason ? { headCheckReason: refusal.reason } : {}),
      },
    },
  };
}
