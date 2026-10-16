/**
 * work-driver-retry-context — what a step retry costs, said out loud.
 *
 * The step router's retry re-runs a step by dispatching a brand-new child: the
 * failed child's conversation is not carried over. That is a deliberate
 * fallback (the child's own in-process retry, which keeps the context, has
 * already been exhausted by the time the driver sees the failure), but it was
 * silent in both directions. The operator saw `retrying attempt 2` with no
 * hint that 15 minutes of explore had just been thrown away, and a retried
 * developer was handed the same "start from the issue" prompt as the first
 * one — in a worktree that still held the first one's edits and commits.
 *
 * Three pure helpers, all reading the state / failure event the caller already
 * has: `lostAttemptLine` for the scrollback/trace line, `interruptedDevelopNote`
 * for the retried developer's prompt, and `lostAttemptOnStep` for the one
 * question #1391's reposition gate asks — *is the dirt in this tree the dirt
 * the attempt I just lost left behind?*
 */

import { dispatchTokens } from "./work-driver-cycle-total.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";
import { fmtElapsed, fmtTokens } from "./work-status-events.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

type FailureEvent = Extract<WorkEvent, { kind: "dispatch-failed" | "dispatch-failed-provider" }>;

/** "15m09s, 45 turns, 412k tokens" — only the parts the event actually carries. */
function spent(e: FailureEvent): string {
  const parts = [fmtElapsed(e.ms)];
  const turns = e.usage?.turns ?? 0;
  if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  const tokens = dispatchTokens(e);
  if (tokens > 0) parts.push(`${fmtTokens(tokens)} tokens`);
  return parts.join(", ");
}

/**
 * The operator-facing account of what a retry discards. `attempt` is the
 * attempt that FAILED (1-based). `develop` differs from every other step: its
 * worktree outlives the child, so only the conversation is lost.
 */
export function lostAttemptLine(step: WorkStep, attempt: number, e: FailureEvent): string {
  const kept =
    step === "develop"
      ? "its conversation is gone, files it left in the worktree are kept"
      : "the step restarts from the beginning";
  return `${step} attempt ${attempt} lost: ${spent(e)} — ${kept}`;
}

/**
 * The note a RETRIED developer gets, or undefined on a first attempt.
 *
 * Keyed on the transient-retry counter the router bumps before it re-runs the
 * step (and clears when the step succeeds), so an adversarial fix pass — a new
 * attempt with feedback, not an interruption — never carries it. The cause is
 * the classified enum, never the provider's message: that text is untrusted
 * and has no business inside a prompt.
 */
export function interruptedDevelopNote(state: WorkState): string | undefined {
  const used = state.pipelineState.transientRetryAttempts?.develop ?? 0;
  if (used === 0) return undefined;
  let failed: FailureEvent | undefined;
  for (let i = state.eventLog.length - 1; i >= 0 && !failed; i--) {
    const e = state.eventLog[i];
    if (
      (e?.kind === "dispatch-failed" || e?.kind === "dispatch-failed-provider") &&
      e.step === "develop" &&
      e.role === "developer"
    ) {
      failed = e;
    }
  }
  const how = failed
    ? ` (cause: ${classifyFailureCause(failed).cause}) after ${spent(failed)}`
    : "";
  return [
    "## A previous attempt at this step was interrupted",
    "",
    `Attempt ${used} of this implementation step was cut short by an infrastructure failure${how}. It was interrupted, not judged, and its conversation is gone — but you are in the SAME worktree, so whatever it edited or committed may still be on disk. Before implementing anything, run \`git status --short\` and \`git log --oneline -10\` and read what is there. Continue from that work instead of redoing it; discard only what you can see is wrong or incomplete.`,
    "",
  ].join("\n");
}

/**
 * #1391 — the operator-facing note a RETRIED lens-fix developer gets, or
 * undefined when this is a fresh round (or no lens-fix child was ever lost).
 *
 * The develop step already tells its retried child "your predecessor's edits
 * may still be on disk — read them before you write anything"
 * (`interruptedDevelopNote`). The lens-fix step had no equivalent, so a
 * round-2 fixer dispatched after a lost attempt was handed a byte-identical
 * prompt to the dead child's, in the same tree, with no hint that half of what
 * it was about to write might already be there. The consequence measured in
 * cycle 109 was worse than duplication: the fix was never dispatched at all,
 * because the reposition gate parked on the residue first.
 *
 * Keyed on the lens-fix retry counters rather than `reviewRound`: a normal
 * round 2 is a NEW attempt with feedback (the previous round's fix landed and
 * the lens found more), and must not be told it is resuming an interrupted
 * child. Only a lost child sets a counter.
 *
 * The cause is the classified enum, never the provider's own text — that is
 * untrusted input with no business inside a prompt.
 */
export function interruptedLensFixNote(state: WorkState): string | undefined {
  const used =
    (state.pipelineState.transientRetryAttempts?.["lens-fix"] ?? 0) +
    (state.pipelineState.retryAttempts?.["lens-fix"] ?? 0);
  if (used === 0) return undefined;
  let failed: FailureEvent | undefined;
  for (let i = state.eventLog.length - 1; i >= 0 && !failed; i--) {
    const e = state.eventLog[i];
    if (
      (e?.kind === "dispatch-failed" || e?.kind === "dispatch-failed-provider") &&
      e.step === "lens-fix" &&
      e.role === "developer"
    ) {
      failed = e;
    }
  }
  const how = failed
    ? ` (cause: ${classifyFailureCause(failed).cause}) after ${spent(failed)}`
    : "";
  return [
    "## A previous attempt at this fix round was interrupted",
    "",
    `Attempt ${used} of this lens-fix round was cut short by an infrastructure failure${how}. It was interrupted, not judged, and its conversation is gone — but you are in the SAME worktree, so whatever it edited may still be on disk. Before changing anything, run \`git status --short\` and \`git diff\` and read what is there. Continue from that work rather than redoing it, and commit what you keep: \`git add -A\` followed by \`git commit -m "<type>(scope): concise subject"\`. Do NOT push.`,
    "",
  ].join("\n");
}

/**
 * #1391 — true when the step now being entered has ALREADY lost an attempt to
 * a failure the router classified as retryable, i.e. we are on attempt N>1 of
 * a step whose earlier child died mid-flight and left the worktree alone.
 *
 * This is the only signal that separates "the dirt in this worktree is mine —
 * the driver caused it by losing its own child" from "the dirt is the
 * operator's in-progress work". The two look byte-identical to
 * `git status --porcelain`, and the reposition guard read every dirty tree as
 * the latter: cycle 109 lost its round-2 lens-fix developer at 01:56:00, the
 * retry dispatched, and the gate parked the cycle one second later on the dirt
 * the dead child had written.
 *
 * **Both** retry budgets count, not only `transientRetryAttempts` (#297): the
 * `retryAttempts` (#274) semantic budget is bumped by the RETRY_ONCE branch of
 * the same router, for the same kind of lost child. A guard that read only the
 * transient counter would still park a lens-fix round 2 that followed a
 * semantic retry — same bug, narrower.
 *
 * Both counters are step-scoped and cleared when the step succeeds (see
 * `routeStepOutcome`), so `true` is scoped to the step that lost the attempt:
 * a develop retry earlier in the cycle licenses nothing at lens-fix, nor the
 * other way round.
 */
export function lostAttemptOnStep(state: WorkState, step: WorkStep): boolean {
  if ((state.pipelineState.transientRetryAttempts?.[step] ?? 0) > 0) return true;
  return (state.pipelineState.retryAttempts?.[step] ?? 0) > 0;
}
