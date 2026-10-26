/**
 * work-driver-diff-read-park — #1634: the adversarial gate parks when the
 * DRIVER could not read the diff, and it parks AT ONCE.
 *
 * Split from `work-driver-step-router.ts` (AGENTS.md §12 file-size limit),
 * which owns the retry ladders; this is the one dispatch failure that must not
 * enter them.
 *
 * Why no ladder: a diff read is DETERMINISTIC. A missing worktree path, a
 * directory that is not a repository, or a `git diff` that fails says the same
 * thing the second time, so re-running it buys a multi-second (provider-floor)
 * wait and changes nothing. Both budgets — the #308 transient ladder and
 * #298's RETRY_ONCE — are skipped on the strength of the `diffUnreadable`
 * marker the fan-out stamps on the event it synthesises
 * (`work-driver-adversarial-fanout-diff.ts`). Nothing here matches on prose:
 * the old router tested a prefix of `errorTail`, a string the reason renderer
 * owns, and a reworded reason silently lost both the cap and the exemption.
 *
 * Why the halt is APPENDED here rather than left to the branch that runs after
 * this one returns: a RETRY_ONCE step whose retry branch is skipped falls
 * through to the linear step table and ADVANCES, which is the #1634 bug class
 * one step on — a gate that could not read anything moving on to commit-pr.
 */

import { trace } from "./trace.ts";
import type { DispatchFailureEvent } from "./work-driver-provider-park.ts";
import { dispatchFailCapHit } from "./work-driver-provider-park.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";
import { appendEvent, persistCycle } from "./workflow-state.ts";

/** What the park needs from the cycle: the persistence target and the interrupt signal. */
export interface DiffReadParkCtx {
  repoRoot: string;
  emitSink: Parameters<typeof persistCycle>[0]["emitSink"];
  signal?: AbortSignal;
}

/** Did this dispatch-failure event record the driver's failed diff READ? */
export function isUnreadableDiffTail(step: WorkStep, tail: DispatchFailureEvent): boolean {
  return step === "adversarial" && tail.kind === "dispatch-failed" && tail.diffUnreadable === true;
}

/**
 * The deterministic-read park: append the cap that names the read and hand off,
 * without spending either retry budget. Returns the routed state, or `undefined`
 * when this failure is not the read (so the caller's ladders run unchanged).
 */
export async function parkUnreadableDiffRead(
  ctx: DiffReadParkCtx,
  state: WorkState,
  step: WorkStep,
  tail: DispatchFailureEvent,
): Promise<{ state: WorkState; retry: true } | undefined> {
  if (!isUnreadableDiffTail(step, tail)) return undefined;
  trace(
    `work-driver: step="${step}" died on the driver's own diff read — no retry ladder (deterministic), parking at once`,
  );
  const capEvent = dispatchFailCapHit(step, state, tail);
  let next = appendEvent(state, capEvent);
  next = { ...next, pipelineState: { ...next.pipelineState, currentStep: "handoff" } };
  await persistCycle(ctx, next);
  trace(
    `work-driver: HALT on step="${step}" (diff unreadable) → cap="${capEvent.cap}" → handoff (status set in runHandoff)`,
  );
  return { state: next, retry: true };
}
