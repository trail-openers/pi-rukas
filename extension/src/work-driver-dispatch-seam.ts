/**
 * work-driver-dispatch-seam — the generic single-dispatch step body.
 *
 * `runSingleDispatch` is the one place a driver step "appends step-started,
 * dispatches one subagent, appends the completion event", so the three things
 * every such step must get right live once: the WRITE-AHEAD marker (#382), the
 * ONE jobId per dispatch that the child's `runId`, the marker and the completion
 * event all name (#1789), and the in-flight clear whichever way it settled.
 * Steps that emit extra events (adversarial verdicts, lens verdicts, CI status)
 * implement their own runX and call `dispatchCore` directly.
 *
 * Split out of `work-driver-merged.ts` (AGENTS.md §12 file-size limit), which
 * keeps the Step 9 merge handler and the reply parsers.
 */

import { slowRecorder } from "./slow-events.ts";
import type { DispatchResult, WriteFenceOpt } from "./types.ts";
import { buildCompletionEvent } from "./work-driver-completion-event.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { cycleDispatch } from "./work-driver-cycle-entry.ts";
import { driverDeckOpts } from "./work-driver-deck-header.ts";
import { beginDispatch, clearDispatch, mintJobId } from "./work-driver-resume.ts";
import { type WorkState, type WorkStep, appendEvent } from "./workflow-state.ts";

/**
 * Generic single-dispatch helper used by every step body whose shape is
 * "append step-started → dispatch one subagent → append completion event".
 * Steps that need to emit additional events (adversarial verdicts, lens
 * verdicts, CI status) implement their own runX and call dispatchCore
 * directly.
 */
export async function runSingleDispatch(
  ctx: CycleContext,
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  now: number,
  buildPrompt: () => string,
  opts?: WriteFenceOpt & {
    timeoutMs?: number;
    cwd?: string;
    /** #1789 — told the id this dispatch carries, as soon as it exists (before
     *  the await), so a caller that must join the completion event back to this
     *  dispatch compares against the id WRITTEN rather than one it recomputed. */
    onJobId?: (jobId: string) => void;
  },
): Promise<WorkState> {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: step } },
    { kind: "step-started", step, at: now },
  );
  const dispatch = cycleDispatch(ctx);
  // #1789 — the jobId is MINTED HERE, once, and nothing else mints a second one
  // for this dispatch: the same id goes to `beginDispatch` (write-ahead marker),
  // to the child as its `runId` (so the transcript file's basename carries it)
  // and to the completion event, so a reader that joins a tail event to the
  // dispatch that wrote it is comparing one identity against itself. Previously
  // the driver's id and the transcript-derived id were two unrelated mintings, so
  // "is this tail MY dispatch's failure?" had no honest answer — and an id
  // RECOMPUTED from (step, label, now) at two call sites was not one identity
  // either: the two `Date.now()` reads land a millisecond apart often enough to
  // mis-reject a conversion (~20%, measured), so the caller receives the id this
  // seam minted through `onJobId` instead of deriving its own.
  const startedAt = Date.now();
  const jobId = mintJobId(step, label, startedAt);
  opts?.onJobId?.(jobId);
  // #382 — WRITE-AHEAD. A dispatch can run for thirty minutes; before this,
  // nothing hit disk until it returned, so a crash inside that window left
  // the state file at the PREVIOUS step boundary still claiming `running`. A
  // crashed cycle was indistinguishable from a live one, forever. Persisting
  // the intent first is what makes the difference visible on resume.
  const begun = await beginDispatch(ctx, next, step, role, label, startedAt, undefined, jobId);
  next = begun.state;
  let result: DispatchResult;
  // #1789 — the result carries the id this step's dispatch is identified by, so
  // the completion event can be recognised as THIS dispatch's (see
  // `DispatchResult.dispatchJobId`). It is the very string `beginDispatch` and
  // the child's `runId` received, and the caller learned it through `onJobId`,
  // so the join compares one value rather than two mintings that might differ.
  try {
    // PR15 — per-call timeout override (3-min default; runCi lifts it to 30).
    // #799 — plain `await dispatch(...)`. The earlier periodic heartbeat
    // wrapped this await in a loop that slept out its first interval and
    // then awaited the (already settled) promise — so it never emitted.
    // The slow-run watch now lives in the dispatch layer (slow-notice.ts,
    // one watch per job at startJob) and records `dispatch-slow` through
    // the `onSlow` callback; there is no driver-side polling loop here.
    // The await itself is unchanged: same promise, same resolution.
    result = await dispatch(
      ctx.host,
      // `cwd` matters when work lives elsewhere (lens-fix: worktree, not repoRoot).
      // #1789 — `runId` is the driver's jobId, so the child's transcript carries
      // it and the completion event can name the dispatch it came from (see
      // `driverJobIdOf`). A fake dispatch that ignores it is unaffected: the
      // event falls back to whatever transcript path the fake reports.
      {
        role,
        prompt: buildPrompt(),
        runId: jobId,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      },
      {
        label,
        timeoutMs: opts?.timeoutMs,
        writeFence: opts?.writeFence,
        // #799 — the slow recorder collects the crossings into the driver's
        // pending buffer (keyed by this cycle's primary issue); the
        // step-boundary drain (routeStepOutcome) persists them — this step
        // folds nothing of its own any more.
        onSlow: slowRecorder(ctx.issue, step),
        // #838 — the shared single-dispatch seam: every step that routes
        // through runSingleDispatch (branch ops fallback, ci, lens-fix,
        // step-back, merged, ...) gets its deck row from here (label
        // `#<issue> <step> · <label>`) — one seam for every step-dispatch
        // shape.
        deck: { ...driverDeckOpts(ctx.issue, step, label), label },
      },
    );
  } catch (err) {
    // #799 — a crossing recorded before the failure survives in the pending
    // buffer and is drained at the step boundary; the failure append here
    // needs no ref fold.
    return appendEvent(clearDispatch(next, jobId), {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  // #1789 — tag the result with the id this step's dispatch carries, so the
  // completion event `buildCompletionEvent` builds is identifiable as THIS
  // dispatch's (see `DispatchResult.dispatchJobId`). A step that must prove the
  // tail event is its own kill — the lens-fix bound-land conversion — has
  // nothing else to compare against: the transcript basename alone is spawn's
  // runId, and for a PM dispatch it stays exactly that.
  result.dispatchJobId = jobId;

  const event = await buildCompletionEvent(ctx, step, role, label, result);
  // Clear the in-flight marker whichever way the dispatch settled — a
  // completed dispatch that still looks in-flight would make the next
  // invocation resume a step that already finished.
  return appendEvent(clearDispatch(next, jobId), event);
}
