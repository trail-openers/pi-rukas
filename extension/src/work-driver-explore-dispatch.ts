import { dispatchCore } from "./dispatch.ts";
/**
 * work-driver-explore-dispatch — one explore dispatch attempt, plus the #1094
 * "no readable `## Spec`" predicate and retry preface.
 *
 * `dispatchExploreAttempt` is the write-ahead / spec-artifact / completion
 * sequence that `runExplore` used to inline, lifted so the single retry runs
 * the identical sequence (#382 resume state, #594 artifact hygiene, #573
 * transcript path). A FAILED dispatch returns no reply: the router owns it and
 * the retry must never fire on one (dispatch-failed tail, #686/#693).
 */
import { readMarker } from "./reply-markers.ts";
import { slowRecorder } from "./slow-events.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import type { DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { deleteSpecArtifact, readSpecArtifact } from "./work-driver-intent-artifact.ts";
import { recoverOffloadedSpec } from "./work-driver-intent-offload.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Result of one explore attempt. `reply` is set only for a completed dispatch. */
export interface ExploreAttempt {
  state: WorkState;
  jobId: string;
  reply?: DispatchResult;
}

/** The preface the single retry prepends to the original explore prompt (#1094). */
export const EXPLORE_RETRY_PREFACE = [
  "RETRY — your previous reply had no `## Spec` heading, so the work-driver could not read it and cannot proceed on it.",
  "Re-emit the whole reply this time: the `INTENT-VERDICT:` line and a `## Spec` block with its subsections, exactly as specified below. Do not substitute any other section name for `## Spec`.",
  "",
  "",
].join("\n");

/** Did the reply carry an `INTENT-VERDICT:` token (bold-wrapped forms included)? */
export function hasIntentVerdictToken(text: string): boolean {
  return (
    readMarker(text, "INTENT-VERDICT", /(proceed-with-assumptions|proceed|park)/) !== undefined
  );
}

/**
 * #1094 — is a COMPLETED explore reply unreadable as a spec? Offloaded specs
 * and a valid persisted artifact count as a spec; a verdict token alone does
 * not, because the `## Spec` body is what the cycle routes on.
 */
export async function replyLacksSpec(ctx: DriverContext, text: string): Promise<boolean> {
  if ((await recoverOffloadedSpec(text, scratchDir(ctx.repoRoot, ctx.issue))) !== undefined) {
    return false;
  }
  return (await readSpecArtifact(ctx.repoRoot, ctx.issue)) === undefined;
}

/**
 * The cap evidence for an explore reply with no readable spec. The no-verdict
 * wording is the long-standing string (#830); the verdict-present wording says
 * the decision was made but its body was not written, which is a different
 * fault for the operator to act on.
 */
export function noSpecEvidence(text: string, retried: boolean): string {
  const base = hasIntentVerdictToken(text)
    ? "INTENT-VERDICT present but no `## Spec` heading parsed"
    : "no verdict and no spec parsed";
  return retried ? `${base} (explore re-dispatched once)` : base;
}

/**
 * Run one explore dispatch: write-ahead (#382), drop the prior spec artifact
 * (#594, intent path only), dispatch, then append the completion or failure
 * event and clear the in-flight marker.
 */
export async function dispatchExploreAttempt(
  ctx: DriverContext,
  state: WorkState,
  prompt: string,
  useIntent: boolean,
): Promise<ExploreAttempt> {
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const exploreRunId = `explore:explore:${process.pid}:${startedAt}`;
  const exploreTranscript = transcriptPathFor("explore", exploreRunId);
  // #382 — write-ahead before the await; see work-driver-resume.ts.
  const begun = await beginDispatch(
    ctx.repoRoot,
    state,
    "explore",
    "explore",
    "explore",
    startedAt,
    exploreTranscript,
  );
  const next = begun.state;
  // #594 — delete the prior cycle's spec artifact before dispatch (best-effort,
  // trace on failure). Gated on useIntent: the artifact is only used on the
  // intent path, so on the legacy path (PI_ENSEMBLE_INTENT=0 or N>1) leave it.
  if (useIntent) {
    await deleteSpecArtifact(ctx.repoRoot, ctx.issue);
  }
  const dispatchSettled = await Promise.allSettled([
    dispatch(
      ctx.pi,
      { role: "explore", prompt },
      // #799 — the slow recorder collects into the driver's pending buffer;
      // the step boundary (routeStepOutcome) drains it — this step folds
      // nothing.
      {
        label: "explore",
        onSlow: slowRecorder(ctx.issue, "explore"),
        deck: { ...driverDeckOpts(ctx.issue, "explore", "explore"), label: "explore" },
      },
    ),
  ]).then((arr) => arr[0]);

  // A dispatch that did not fulfil is recorded as dispatch-failed. The
  // rejected arm carries the real error; the defensive arm (Promise.allSettled
  // always settles, so unreachable) synthesises one so the driver routes normally.
  if (!dispatchSettled || dispatchSettled.status !== "fulfilled") {
    const errorTail =
      dispatchSettled?.status === "rejected"
        ? (dispatchSettled.reason as Error).message?.slice(-200)
        : "explore dispatch settled in an unexpected state";
    // #799 — a crossing recorded before the failure survives in the pending
    // buffer and is drained at the step boundary; the failure append here
    // needs no ref fold.
    return {
      state: appendEvent(clearDispatch(next, begun.jobId), {
        kind: "dispatch-failed",
        step: "explore",
        role: "explore",
        jobId: begun.jobId,
        label: "explore",
        ms: Date.now() - startedAt,
        at: Date.now(),
        errorTail,
      }),
      jobId: begun.jobId,
    };
  }

  // dispatchSettled.value is the explore role's dispatch result
  // (single-dispatch — explore returns one report covering all issues).
  const exploreDispatch = dispatchSettled.value as DispatchResult;
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  const after = appendEvent(clearDispatch(next, begun.jobId), event);
  // A dispatch that FAILED has no reply to route on (nessie #686/#693).
  return {
    state: after,
    jobId: begun.jobId,
    reply: event.kind === "dispatch-completed" ? exploreDispatch : undefined,
  };
}
