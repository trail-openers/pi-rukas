/**
 * work-driver-merged-hold — the `merged` step's "do not merge" state, split out of
 * work-driver-merged.ts (AGENTS.md §12: split along a natural seam rather than
 * compress a file at the cap).
 *
 * The whole of the merge gate's refusal lives here: the authority verdict, the CI
 * evidence, the round-cap disclosure flag and the head refusal's two SHAs all land
 * in one `mergeHold` record, and every one of them has to be copied into it or the
 * handoff downstream loses the reason the cycle parked.
 *
 * The fields are all OPTIONAL, and the optionality is load-bearing:
 * `explainMergeHold` distinguishes "the gate did not run" from "the gate ran and
 * said X" by whether a field is PRESENT, so writing `undefined` is not the same as
 * omitting a key. Every spread below is a conditional spread for that reason; a
 * refactor into plain keys would turn silent absences into asserted ones.
 */

import { errText } from "./protected-paths-text.ts";
import type { MergeAuthority } from "./work-driver-merge-authority.ts";
import type { MergeEvidence } from "./work-driver-merge-evidence.ts";
import type { HeadCheck } from "./work-driver-merged-head.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The `merged`-step state for a cycle that must NOT merge: same shape the caller
 * holds, with `currentStep` at `merged` and a `mergeHold` recording why.
 *
 * `routedRoundCap` marks the shape where a cycle reached the merge step with
 * unresolved lens findings carried forward under the round cap. It is passed in
 * rather than re-derived here so the caller's single evaluation of
 * `heldByUnresolvedReview` is the one the hold records.
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
        // The two SHAs a head refusal names, structured rather than left in
        // prose: the queue's park reason and the handoff renderers read them off
        // the state file.
        ...(refusal?.reviewedHead ? { reviewedHead: refusal.reviewedHead } : {}),
        ...(refusal?.foundHead ? { headAtMerge: refusal.foundHead } : {}),
        ...(refusal?.reason ? { headCheckReason: refusal.reason } : {}),
      },
    },
  };
}

/**
 * The `merged`-step state for a cycle the protected-path gate held: the same
 * `mergeHold` record every other merge refusal writes, so the worktree sweep and
 * the handoff renderers treat a protected-path park like any other held merge
 * instead of seeing a cap-hit with no hold behind it. The authority fields report
 * what this gate actually knows — it asks neither the grant nor the forge, so it
 * neither claims a grant nor denies one — and the reason is the protected-path
 * sentence itself, which is what the operator has to act on.
 */
export function mergeProtectedHold(state: WorkState, reason: string): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "merged",
      mergeHold: {
        authorityGranted: true,
        authoritySource: "none",
        headCheckReason: reason,
      },
    },
  };
}

/**
 * The `merged`-step state for a cycle the merge-author gate held (#2181).
 *
 * Same shape as `mergeProtectedHold`, for the same reason — a park with no hold
 * behind it is a cap-hit the renderers cannot explain — and it reports the same
 * honest authority: this gate asked neither the grant nor the forge about
 * permission, so it claims no verdict on either. The reason rides in
 * `authorGateReason` rather than `headCheckReason` because the two gates need
 * different operator actions: a head park asks you to look at what landed after
 * the review, an author park asks you to decide whether this person's PR is landed
 * at all, and only the field that names them lets the handoff say so.
 */
export function mergeAuthorHold(state: WorkState, reason: string): WorkState {
  return {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "merged",
      mergeHold: {
        authorityGranted: true,
        authoritySource: "none",
        authorGateReason: reason,
      },
    },
  };
}

/** What the author gate answers: a pass, or a refusal carrying its own words. */
export type AuthorGateDecision = { ok: true } | { ok: false; reason?: string };

/**
 * Ask the author gate, and turn an executor rejection into the same park as a
 * refusal.
 *
 * The gate reads git and the forge through the caller's executor, and a read that
 * rejects (a wedged `gh`, an executor that throws rather than answering) is not a
 * signal to let the merge run — the one act it guards is irreversible. It is also
 * not a refusal the gate rendered, so it parks with the executor's own error text
 * as the reason and reaches the caller through the same `mergeAuthorHold` a refusal
 * uses. Without the catch the rejection escaped `runMerged` and the cycle parked
 * with no `mergeHold` behind it, the shape neither the sweep nor the handoff can
 * explain. A refusal that carried no reason of its own gets a generic one, so a
 * hold is never rendered with an empty explanation.
 */
export async function askAuthorGate(
  authorGate: (
    evidence: { author?: string; authorError?: string } | undefined,
  ) => Promise<AuthorGateDecision>,
  evidence: { author?: string; authorError?: string } | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const decision = await authorGate(evidence);
    return decision.ok
      ? { ok: true }
      : { ok: false, reason: decision.reason ?? "the author gate refused" };
  } catch (err) {
    return { ok: false, reason: `the author gate could not run: ${errText(err)}` };
  }
}
