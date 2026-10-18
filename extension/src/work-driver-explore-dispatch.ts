/**
 * work-driver-explore-dispatch — one explore dispatch attempt, plus the #1094
 * "no readable `## Spec`" resolver, retry predicate and retry preface.
 *
 * `dispatchExploreAttempt` is the write-ahead / completion sequence that
 * `runExplore` used to inline, lifted so the single retry runs the identical
 * sequence (#382 resume state, #573 transcript path). It takes no intent
 * policy: the caller clears the prior spec artifact (#594) before each attempt.
 * A FAILED dispatch returns no reply: the router owns it and the retry must
 * never fire on one (dispatch-failed tail, #686/#693).
 */
import { dispatchCore } from "./dispatch.ts";
import { readMarker } from "./reply-markers.ts";
import { slowRecorder } from "./slow-events.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import type { DispatchResult } from "./types.ts";
import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { readSpecArtifact, resolveIntentVerdict } from "./work-driver-intent-artifact.ts";
import { recoverOffloadedSpec } from "./work-driver-intent-offload.ts";
import type { NormalisedSpec } from "./work-driver-intent.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/** Result of one explore attempt. `reply` is set only for a completed dispatch. */
export interface ExploreAttempt {
  state: WorkState;
  /** The job id on the event that recorded this attempt's outcome (#1548). */
  jobId: string;
  reply?: DispatchResult;
}

/** A readable spec resolved from an explore reply, and which channel won. */
export interface ResolvedExploreSpec {
  spec: NormalisedSpec;
  source: "prose" | "artifact";
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
 * #1094 — the ONE definition of a readable spec. An inline `## Spec` block,
 * an offloaded spec file, or a valid persisted artifact counts; a verdict
 * token alone does not, because the `## Spec` body is what the cycle routes
 * on. Both the retry decision and the routing call this, so the reply is read
 * once and the two can never disagree.
 */
export async function resolveExploreSpec(
  ctx: Pick<DriverContext, "repoRoot" | "issue">,
  text: string,
): Promise<ResolvedExploreSpec | undefined> {
  const prose = await recoverOffloadedSpec(text, scratchDir(ctx.repoRoot, ctx.issue));
  const artifact = await readSpecArtifact(ctx.repoRoot, ctx.issue);
  const { spec, source } = resolveIntentVerdict(prose, artifact);
  return spec === undefined ? undefined : { spec, source };
}

/**
 * #1094 — the explore re-dispatch decision, as a pure function. The caller
 * only asks after a COMPLETED dispatch (a failed one returns before any reply
 * is read), so the predicate is just: intent path and no readable spec.
 */
export function shouldRetryExplore(input: {
  useIntent: boolean;
  spec: NormalisedSpec | undefined;
}): boolean {
  return input.useIntent && input.spec === undefined;
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
 * Run one explore dispatch: write-ahead (#382), dispatch, then append the
 * completion or failure event and clear the in-flight marker.
 */
export async function dispatchExploreAttempt(
  ctx: CycleContext,
  state: WorkState,
  prompt: string,
): Promise<ExploreAttempt> {
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const exploreRunId = `explore:explore:${process.pid}:${startedAt}`;
  const exploreTranscript = transcriptPathFor("explore", exploreRunId);
  // #382 — write-ahead before the await; see work-driver-resume.ts.
  const begun = await beginDispatch(
    ctx,
    state,
    "explore",
    "explore",
    "explore",
    startedAt,
    exploreTranscript,
  );
  const next = begun.state;
  let exploreDispatch: DispatchResult;
  try {
    exploreDispatch = await dispatch(
      ctx.host,
      { role: "explore", prompt },
      // #799 — the slow recorder collects into the driver's pending buffer;
      // the step boundary (routeStepOutcome) drains it — this step folds
      // nothing.
      {
        label: "explore",
        onSlow: slowRecorder(ctx.issue, "explore"),
        deck: { ...driverDeckOpts(ctx.issue, "explore", "explore"), label: "explore" },
      },
    );
  } catch (err) {
    // A dispatch that did not fulfil is recorded as dispatch-failed with the
    // real error. A crossing recorded before the failure survives in the
    // pending buffer and is drained at the step boundary (#799).
    const errorTail = (err instanceof Error ? err.message : String(err)).slice(-200);
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

  // The explore role returns one report covering all issues (single dispatch).
  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", exploreDispatch);
  const after = appendEvent(clearDispatch(next, begun.jobId), event);
  // A dispatch that FAILED has no reply to route on (lantern #686/#693).
  return {
    state: after,
    jobId: event.jobId,
    reply: event.kind === "dispatch-completed" ? exploreDispatch : undefined,
  };
}
