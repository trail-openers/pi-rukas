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
 * Two pure helpers, both reading the failure event the router already has:
 * `lostAttemptLine` for the scrollback/trace line, `interruptedDevelopNote`
 * for the retried developer's prompt.
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

/** What a retry is dispatching into, said once the driver has cleaned it. */
export type RetryTreeAccount = string | undefined;

/**
 * The operator-facing account of what a retry discards. `attempt` is the
 * attempt that FAILED (1-based). The kept clause is per-step, because what
 * survives a lost child is genuinely different per step: `develop` runs the
 * #622 safety net per worktree before the step returns, so a lost attempt's
 * edits are commits on disk and the retry builds on them; `lens-fix` had no
 * such net, which is the #1391 shape — its uncommitted residue was read by the
 * next round as operator dirt and parked the cycle. `tree` is the #1391
 * account of what the lost attempt left in the retry's worktree and what the
 * driver did with it (see work-retry-tree-clean.ts).
 */
export function lostAttemptLine(
  step: WorkStep,
  attempt: number,
  e: FailureEvent,
  tree?: RetryTreeAccount,
): string {
  const kept =
    step === "develop"
      ? // The develop step runs the #622 safety net per worktree before it
        // returns, so a lost attempt's edits are ON DISK as commits — the
        // retry builds on them (cycle 60: "files it left are kept").
        "its conversation is gone, files it left in the worktree are kept"
      : step === "lens-fix"
        ? // #1391 — lens-fix had no such net: its uncommitted residue was read
          // by the next round as operator dirt and parked the cycle. The clean
          // seam says what happened to it, so this half stays true either way.
          "its conversation is gone and the fix work it left is handled below"
        : "the step restarts from the beginning";
  const parts = [`${step} attempt ${attempt} lost: ${spent(e)} — ${kept}`];
  if (tree !== undefined) parts.push(tree);
  return parts.join(" · ");
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
