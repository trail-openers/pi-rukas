/**
 * work-driver-handoff-ops — the @ops handoff dispatch leg of `runHandoff`.
 *
 * Split (§12 file-size limit) from `work-driver-handoff.ts`: owns the
 * bounded ops dispatch — the `timeoutMs` + `Promise.race` double enforcement
 * (the bound itself lives in `handoffDispatchTimeoutMs` there), the #382
 * write-ahead resume bookkeeping (`beginDispatch` / `clearDispatch`), the
 * #573 transcript path, and the completion / `dispatch-failed` event
 * construction. `runHandoff` calls `runHandoffOpsDispatch` and works with the
 * returned reply text and state, exactly as before the split.
 */

import { dispatchCore } from "./dispatch.ts";
import { slowRecorder } from "./slow-notice.ts";
import { transcriptPathFor } from "./spawn-support.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { inlineHandoffOpsPrompt } from "./work-driver-prompts-late.ts";
import { beginDispatch, clearDispatch } from "./work-driver-resume.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Dispatch @ops to post the handoff comment + apply the label, bounded by
 * `handoffDispatchTimeoutMs()` (a reply that outlives the bound is not
 * trusted — the caller falls back to the in-process forge post). Returns
 * the updated state (completion or `dispatch-failed` event appended) plus
 * the reply text (empty string when the dispatch failed or exceeded its
 * bound).
 */
export async function runHandoffOpsDispatch(
  ctx: DriverContext,
  state: WorkState,
  handoffBodyPath: string,
): Promise<{ next: WorkState; opsReplyText: string }> {
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const boundMs = handoffDispatchTimeoutMs();
  const startedAt = Date.now();
  const prNumber = state.pipelineState.prNumber;
  let next = state;
  const prompt = inlineHandoffOpsPrompt(
    ctx.issue,
    prNumber,
    handoffBodyPath,
    scratchDir(ctx.repoRoot, ctx.issue),
  );
  // #573 — derive transcript path BEFORE beginDispatch so crash-resume can
  // locate the surviving session file. Single dispatch: seq=undefined.
  const handoffRunId = `handoff:ops:${process.pid}:${startedAt}`;
  const handoffTranscript = transcriptPathFor("ops", handoffRunId);
  // #382 — write-ahead: persist the intent to dispatch BEFORE awaiting.
  const begun = await beginDispatch(
    ctx.repoRoot,
    next,
    "handoff",
    "ops",
    "handoff",
    startedAt,
    handoffTranscript,
  );
  next = begun.state;
  let opsReplyText = "";
  // Two enforcement points, deliberately: `timeoutMs` makes spawn SIGTERM the
  // real child so an abandoned handoff agent is not left running, and the race
  // is what frees the DRIVER. Only the race can be relied on — an injected
  // dispatchFn, a wedged job wrapper or a child that ignores the signal all
  // leave the promise pending, which is the shape that cost #626 26 minutes.
  let boundTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bound = new Promise<"bound">((resolve) => {
      boundTimer = setTimeout(() => resolve("bound"), boundMs);
      boundTimer.unref?.();
    });
    const res = await Promise.race([
      dispatch(
        ctx.pi,
        { role: "ops", prompt },
        {
          label: "ops:handoff",
          timeoutMs: boundMs,
          // #799 — the slow recorder collects into the driver's pending
          // buffer; the step boundary (routeStepOutcome) drains it. The
          // child may outlive the race (below) — its crossings are recorded
          // either way and land in the log with the step's own events. If
          // they are never drained, dropSlowEvents at the end of runHandoff
          // (the cycle's terminal step) removes the leftover entry.
          onSlow: slowRecorder(ctx.issue, "handoff"),
        },
      ),
      bound,
    ]);
    next = clearDispatch(next, begun.jobId);
    if (res === "bound") {
      trace(`work-driver: handoff ops dispatch exceeded ${boundMs}ms — using in-process gh`);
      next = appendEvent(next, {
        kind: "dispatch-failed",
        step: "handoff",
        role: "ops",
        jobId: "unknown",
        label: "ops:handoff",
        ms: Date.now() - startedAt,
        at: Date.now(),
        // Deliberately NO `killCause`. Nothing was killed — the driver stopped
        // waiting and took the fallback, and the child may still be running.
        // Tagging this as a kill would also make it the newest kill in the log,
        // so `killDetail()` would report the handoff's own bound instead of the
        // kill that actually ended the cycle — burying the cause under the
        // report of it. The errorTail below already says what happened.
        errorTail: `handoff ops dispatch exceeded its ${boundMs}ms bound (PI_ENSEMBLE_HANDOFF_TIMEOUT_MS); the in-process gh fallback posted the comment instead`,
      });
    } else {
      opsReplyText = res.text ?? "";
      const completionEvent = await buildCompletionEvent(ctx, "handoff", "ops", "ops:handoff", res);
      next = appendEvent(next, completionEvent);
    }
  } catch (err) {
    trace(`work-driver: handoff ops dispatch threw: ${(err as Error).message}`);
    next = appendEvent(clearDispatch(next, begun.jobId), {
      kind: "dispatch-failed",
      step: "handoff",
      role: "ops",
      jobId: "unknown",
      label: "ops:handoff",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  } finally {
    // The bounded race frees the DRIVER; the child it was racing may still be
    // running, so the slow watch is deliberately NOT stopped here — its
    // crossings keep recording until the child settles (the watch's own
    // settle path owns the stop). Its recorded crossings belong to the log
    // either way.
    if (boundTimer) clearTimeout(boundTimer);
  }
  return { next, opsReplyText };
}
