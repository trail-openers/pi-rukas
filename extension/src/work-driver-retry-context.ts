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
 * Pure helpers reading the failure event and state the caller already has:
 * `lostAttemptLine` for the scrollback/trace line, `interruptedDevelopNote` /
 * `interruptedLensFixNote` for the retried child's prompt, and
 * `lostAttemptOnStep` — #1391's one question: is the dirt in this tree what
 * the attempt the driver just lost left behind?
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
 * attempt that FAILED (1-based). `develop` and `lens-fix` differ from every
 * other step: their worktree outlives the child, so only the conversation is
 * lost. `tree` is the #1391 account of what the child left in that worktree
 * and what the driver did with it (`retryTreeLine`).
 */
export function lostAttemptLine(
  step: WorkStep,
  attempt: number,
  e: FailureEvent,
  tree?: string,
): string {
  const kept =
    step === "develop" || step === "lens-fix"
      ? "its conversation is gone, files it left in the worktree are kept"
      : "the step restarts from the beginning";
  const line = `${step} attempt ${attempt} lost: ${spent(e)} — ${kept}`;
  return tree === undefined ? line : `${line} · ${tree}`;
}

/** The newest #1391 save of a lost attempt's work on `step`, if any. */
function lastSave(
  state: WorkState,
  step: WorkStep,
): Extract<WorkEvent, { kind: "retry-tree-clean" }> | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === "retry-tree-clean" && e.step === step) return e;
  }
  return undefined;
}

/** The prompt sentence that tells a retried child where its predecessor's
 *  work went: in the tree (kept), or in a patch it can re-apply (cleaned). */
function whereTheWorkIs(state: WorkState, step: WorkStep): string {
  const save = lastSave(state, step);
  if (save?.outcome === "cleaned" && save.patch !== undefined) {
    return `The driver saved its uncommitted edits (${save.fileCount} file(s)) to \`${save.patch}\` (also ref \`${save.ref}\`) and reset the worktree, so you start on a clean tree. Read the patch first — \`git apply ${save.patch}\` restores it — and continue from that work instead of redoing it; keep only what you can see is right.`;
  }
  return "You are in the SAME worktree, so whatever it edited or committed may still be on disk. Before changing anything, run `git status --short` and `git log --oneline -10` and read what is there. Continue from that work instead of redoing it; discard only what you can see is wrong or incomplete.";
}

function lastFailure(state: WorkState, step: WorkStep): FailureEvent | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (
      (e?.kind === "dispatch-failed" || e?.kind === "dispatch-failed-provider") &&
      e.step === step &&
      e.role === "developer"
    ) {
      return e;
    }
  }
  return undefined;
}

function interruptedNote(
  state: WorkState,
  step: WorkStep,
  heading: string,
  what: string,
): string | undefined {
  const used =
    (state.pipelineState.transientRetryAttempts?.[step] ?? 0) +
    (state.pipelineState.retryAttempts?.[step] ?? 0);
  if (used === 0) return undefined;
  const failed = lastFailure(state, step);
  const how = failed
    ? ` (cause: ${classifyFailureCause(failed).cause}) after ${spent(failed)}`
    : "";
  return [
    `## A previous attempt at ${heading} was interrupted`,
    "",
    `Attempt ${used} of this ${what} was cut short by an infrastructure failure${how}. It was interrupted, not judged, and its conversation is gone. ${whereTheWorkIs(state, step)}`,
    "",
  ].join("\n");
}

/**
 * The note a RETRIED developer gets, or undefined on a first attempt.
 *
 * Keyed on the retry counters the router bumps before it re-runs the step (and
 * clears when the step succeeds), so an adversarial fix pass — a new attempt
 * with feedback, not an interruption — never carries it. The cause is the
 * classified enum, never the provider's message: that text is untrusted and
 * has no business inside a prompt.
 */
export function interruptedDevelopNote(state: WorkState): string | undefined {
  return interruptedNote(state, "develop", "this step", "implementation step");
}

/**
 * #1391 — the same note for a retried lens-fix developer. A normal round 2 is a
 * new attempt with feedback and sets no counter, so it is never told it is
 * resuming an interrupted child.
 */
export function interruptedLensFixNote(state: WorkState): string | undefined {
  return interruptedNote(state, "lens-fix", "this fix round", "fix round");
}

/**
 * #1391 — true when `step` has already lost an attempt the router retried, so
 * dirt in its tree is the driver's residue rather than operator work. BOTH
 * budgets count: RETRY_ONCE bumps `retryAttempts`, the transient branch
 * `transientRetryAttempts`. Both are step-scoped and cleared on success.
 */
export function lostAttemptOnStep(state: WorkState, step: WorkStep): boolean {
  return (
    (state.pipelineState.transientRetryAttempts?.[step] ?? 0) > 0 ||
    (state.pipelineState.retryAttempts?.[step] ?? 0) > 0
  );
}
