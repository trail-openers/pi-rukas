/**
 * work-driver-draft-disclosure — the positive fact that a review round's
 * residual findings reached the PR.
 *
 * The other half of the #1398 pair: `work-driver-draft-rearm.ts` puts the PR
 * back under the review; this records the disclosure the ready gate then reads.
 * Split from the re-arm module because the two answer different questions — one
 * issues a forge command, the other writes a fact — and share only the
 * `prDraft` record they both update.
 *
 * There used to be NO such fact. `appendReviewCapHit` posted the residual
 * findings and recorded only its `cap-hit`; `recordResidualsPost` emits an event
 * ONLY on a failed PR post; and `readyHoldReason` re-inferred "were the
 * findings disclosed?" from which cap NAME appeared in the tail. So any
 * `ISSUES_FOUND` followed by something other than a round/wall-clock cap that
 * parks (`dispatch-failed`, `verify-failed:*`, a kill cause, `ci-retry`) read as
 * "nothing to hold for" and the PR was marked ready over findings nobody ever
 * posted. `lens-residuals-posted` is the positive fact, recorded by the ordinary
 * disclosure path and the round-cap route alike, keyed on the PATCH IDENTITY the
 * disclosure carries — so a fact recorded for a pre-fix patch never licenses
 * marking the new patch ready.
 *
 * `recordLensResidualsPosted` is the ONLY writer, and both disclosure paths call
 * it, so the gate and the disclosure cannot disagree about what happened.
 */

import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { currentPatchIdentity, withPrDraft } from "./work-driver-draft-pr.ts";
import { rawErrorText } from "./work-driver-draft-rearm.ts";
import type { EmitSink } from "./work-state-emit.ts";
import { type WorkState, appendEvent, persistCycle } from "./workflow-state.ts";

/**
 * Record that a round's residual findings reached the PR.
 *
 * The ordinary disclosure goes through lens-review-residuals.ts, which posts
 * with the merge-guard marker and returns a note naming a failure (empty on
 * success); the round-cap route posts the findings itself. Both call this, so
 * the gate and the disclosure cannot disagree about what happened — that pair
 * used to be two independent inferences, which is how a failed post came to
 * look like nothing at all.
 *
 * The patch identity is computed here, against the refs the disclosure
 * compares, and the fact is written to `pipelineState` AND persisted before this
 * returns: the caller's next act is an awaited dispatch, and a re-arm or a ready
 * decided after a crash must see the fact the pre-crash run recorded. An
 * identity that cannot be computed records nothing — an unanchored fact would
 * license a ready for a patch nobody verified.
 *
 * The persist is wrapped: this runs immediately after a lens dispatch that
 * already succeeded, and a state-file write error must not be reported as a
 * failed review. The event stays in the returned state (which the caller
 * persists at the next step boundary), so a persist failure costs the durable
 * copy and nothing else — it is traced, not thrown.
 */
export async function recordLensResidualsPosted(
  ctx: DriverContext,
  state: WorkState,
  opts: { round: number; prNumber?: number; note?: string },
): Promise<WorkState> {
  // A note means the disclosure FAILED (that is the convention of
  // postLensResidualDisclosure's return) — the failure event belongs to
  // recordResidualsPost, which also runs the issue fallback.
  if (opts.note) return state;
  const branch = state.pipelineState.branchName;
  if (!branch) return state;
  const execFn = ctx.verifyExecFn ?? execp;
  const identity = await currentPatchIdentity(execFn, ctx.repoRoot, branch);
  if (!identity.ok) {
    trace(`work-driver: the residual-disclosure fact was not recorded — ${identity.reason}`);
    return state;
  }
  const at = Date.now();
  const fact = {
    patchId: identity.patchId,
    at,
    round: opts.round,
    ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
  };
  const next = appendEvent(
    withPrDraft(state, {
      ...(state.pipelineState.prDraft ?? { status: "draft" as const }),
      findingsPosted: [...(state.pipelineState.prDraft?.findingsPosted ?? []), fact],
    }),
    {
      kind: "lens-residuals-posted",
      at,
      round: opts.round,
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      branch,
      patchId: identity.patchId,
      target: "pr",
    },
  );
  // Persisted through `persistCycle` (never `writeState`, which the #1162 seam
  // reserves for workflow-state.ts so the emit watermark never sees a persist
  // outside the sink). This helper takes a DriverContext — a step handler may
  // have no sink of its own — so the sink is supplied only when the cycle has
  // one; the write is durable either way, which is the property it exists for.
  // A write error is traced and swallowed: the fact is in the returned state and
  // the review it describes succeeded, so a disk fault is not reported to the
  // operator as a broken lens dispatch.
  try {
    await persistCycle(
      {
        repoRoot: ctx.repoRoot,
        emitSink: ctx.emitSink ?? silentSink,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
      next,
    );
  } catch (err) {
    trace(
      `work-driver: the residual-disclosure fact could not be persisted — ${rawErrorText(err)} (the event is kept in the cycle's state; the next step boundary persists it)`,
    );
  }
  return next;
}

/** A sink that emits nothing — for a persist whose caller has no emit stream. */
const silentSink: EmitSink = { emit: () => undefined, fingerprints: [] };
