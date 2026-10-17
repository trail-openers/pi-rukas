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
import { lensResidualsMarker } from "./merge-guard-round-cap.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { currentPatchIdentity } from "./work-driver-draft-pr.ts";
import { rawErrorText } from "./work-driver-draft-rearm.ts";
import type { EmitSink } from "./work-state-emit.ts";
import type { WorkStep } from "./workflow-state.ts";
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
 * decided after a crash must see the fact the pre-crash run recorded.
 *
 * **An identity that cannot be computed records nothing, and says so.** An
 * unanchored fact would license a ready for a patch nobody verified, so the
 * fact is withheld — but withholding it silently left the operator with a PR
 * held as a draft and no line anywhere explaining why (the #408 lesson: a
 * signal the driver produces and nobody reads). The decline is recorded as a
 * `plumb-report` — the same shape `decline()` in work-driver-draft-rearm.ts
 * writes — naming the git error, and it carries the marker the comment was
 * supposed to carry so a reader can see what was being anchored to.
 *
 * **The fact never invents a draft.** `prDraft` is updated in place, and when
 * the cycle has no draft fact the record carries the disclosure rows and no
 * `status`. Synthesising `status: "draft"` here made the driver claim it was
 * holding a PR it never opened as a draft — an interactive `/work` (drafts off)
 * or an ops-fallback PR opened ready would suddenly render "the PR is still a
 * draft" from the handoff, and `rearmDraftForReview` reads a `status` it never
 * wrote. `workflow-state-schema-pr-draft.ts` makes an absent status a
 * type error, so the two live together and the validator is the gate.
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
  opts: { round: number; prNumber?: number; note?: string; step?: WorkStep },
): Promise<WorkState> {
  // A note means the disclosure FAILED (that is the convention of
  // postLensResidualDisclosure's return) — the failure event belongs to
  // recordResidualsPost, which also runs the issue fallback.
  if (opts.note) return state;
  const branch = state.pipelineState.branchName;
  if (!branch) {
    // item 4 — a disclosure whose branch is unknown cannot be anchored to a
    // patch either, and silence here is the same hole as an unlogged git error.
    return declineUndisclosed(state, opts, "the cycle has no branch name to key it on");
  }
  const execFn = ctx.verifyExecFn ?? execp;
  const identity = await currentPatchIdentity(execFn, ctx.repoRoot, branch);
  if (!identity.ok) {
    trace(`work-driver: the residual-disclosure fact was not recorded — ${identity.reason}`);
    // item 4 — the handoff must explain a draft it cannot lift, so the reason
    // git gave reaches it rather than dying in the trace.
    return declineUndisclosed(state, opts, identity.reason, branch);
  }
  const at = Date.now();
  const fact = {
    patchId: identity.patchId,
    at,
    round: opts.round,
    ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
  };
  const step = opts.step ?? "lens-review";
  // item 3 — the existing draft record is updated IN PLACE. `prDraft` absent
  // stays absent-but-for-the-rows: no `status` is invented, because the driver
  // never opened this PR as a draft and must not claim it is holding one.
  const existing = state.pipelineState.prDraft;
  const next = appendEvent(
    {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        prDraft: {
          ...existing,
          findingsPosted: [...(existing?.findingsPosted ?? []), fact],
        },
      },
    },
    {
      kind: "lens-residuals-posted",
      at,
      round: opts.round,
      ...(opts.prNumber !== undefined ? { prNumber: opts.prNumber } : {}),
      branch,
      patchId: identity.patchId,
      // #1398 round 3 — the marker the comment carries, recorded with the fact.
      // The ready gate's rule is that a fact licenses nothing the PR cannot
      // show; carrying the marker string on the row makes that checkable by a
      // test (test-draft-disclosure-carries-marker-1398.ts) rather than being
      // a property of one caller's prose.
      marker: lensResidualsMarker(branch, identity.patchId),
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

/**
 * The disclosure fact a caller wanted and could not get, made visible.
 *
 * The fact itself is withheld (an unanchored disclosure would license a ready
 * for a patch nobody verified), but the decline is recorded where the handoff
 * renders it — same shape as `decline()` in work-driver-draft-rearm.ts, which
 * is the precedent for "the driver could not act, and the operator finds out".
 *
 * The body names the marker the comment was supposed to carry: that is the
 * thing the identity would have keyed on, and the thing the ready gate looks
 * for, so an operator reading a held PR can tell a disclosure that never landed
 * from an identity that never computed.
 *
 * Appended after the caller's own writes and never as the LAST event of a
 * step (both callers append their `cap-hit` / verdict afterwards), so
 * tail-invariance (#533) — which `nextStep()` routes on — is untouched.
 */
function declineUndisclosed(
  state: WorkState,
  opts: { round: number; prNumber?: number; step?: WorkStep },
  reason: string,
  branch?: string,
): WorkState {
  const step = opts.step ?? "lens-review";
  const pr = opts.prNumber ?? state.pipelineState.prNumber ?? "<N>";
  const markerHint =
    branch === undefined
      ? ""
      : ` The disclosure would have been keyed on \`${lensResidualsMarker(branch, "<patch-id>")}\`.`;
  const body = `Residual-findings disclosure not recorded (round ${opts.round}, PR #${pr}): ${reason}. The cycle cannot state which patch its findings were disclosed for, so the draft gate will not mark the PR ready on this fact${markerHint} Verify the PR carries the disclosure comment and that its head/base refs resolve (\`git merge-base origin/<branch> origin/<mainline>\`).`;
  const withEvent = appendEvent(state, {
    kind: "plumb-report",
    at: Date.now(),
    step,
    role: "driver",
    body,
  });
  // Deduped against BOTH copies, because they are two copies of one claim and
  // the renderers print the field (`plumbReportSection`) while `/work-status`
  // prints the event. The lens step can ask the same question twice in one
  // cycle — the round-cap route declines, then `recordLensResidualsPosted` is
  // called with the same uncomputable identity — and two identical rows read
  // as two problems. Keyed on step + role + body, so two declines with
  // different reasons are still two facts.
  const existing = state.pipelineState.plumbReports ?? [];
  const said =
    existing.some((r) => r.step === step && r.role === "driver" && r.body === body) ||
    state.eventLog.some(
      (e) => e.kind === "plumb-report" && e.step === step && e.role === "driver" && e.body === body,
    );
  if (said) return state;
  return {
    ...withEvent,
    pipelineState: {
      ...withEvent.pipelineState,
      plumbReports: [...existing, { step, role: "driver", body, at: Date.now() }],
    },
  };
}

/** A sink that emits nothing — for a persist whose caller has no emit stream. */
const silentSink: EmitSink = { emit: () => undefined, fingerprints: [] };
