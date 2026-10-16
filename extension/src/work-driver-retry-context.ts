/**
 * work-driver-retry-context — what a step retry costs, said out loud.
 *
 * The step router's retry re-runs a step by dispatching a brand-new child: the
 * failed child's conversation is not carried over. That is a deliberate
 * fallback (the child's own in-process retry, which keeps the context, has
 * already been exhausted by the time the driver sees the failure), but it was
 * silent in both directions. The operator saw `retrying attempt 2` with no hint
 * that 15 minutes of explore had just been thrown away, and a retried developer
 * was handed the same "start from the issue" prompt as the first one — in a
 * worktree that still held the first one's edits.
 *
 * Three pure helpers, all reading what the router already holds:
 * `lostAttemptLine` for the scrollback/trace line, `interruptedDevelopNote` for
 * the retried developer's prompt, and `WORKTREE_EDITING_STEPS` — the one table
 * saying which steps' work lives in a worktree rather than in a deleted child's
 * context, which is what both of those key on.
 *
 * #1391 widened the account. Its job is to say where the lost attempt's work
 * IS, and it used to answer that from the step's name: only `develop` got the
 * "files are kept" clause. `lens-fix` writes files in the lens-fix worktree
 * exactly as `develop` does — and the retry then read its own dirt as the
 * operator's and parked (nessie #109: "round 3 of 3", one second long).
 */

import { dispatchTokens } from "./work-driver-cycle-total.ts";
import { classifyFailureCause } from "./work-driver-failure-taxonomy.ts";
import { fmtElapsed, fmtTokens } from "./work-status-events.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkState, WorkStep } from "./workflow-state.ts";

type FailureEvent = Extract<WorkEvent, { kind: "dispatch-failed" | "dispatch-failed-provider" }>;

/**
 * #1391 — the steps whose work is FILES in a worktree, so a lost attempt keeps
 * them on disk and the account has to say so.
 *
 * The question is where the work lives, not which step the state machine is in.
 * `develop` and `lens-fix` both dispatch a developer that edits a worktree and
 * is told NOT to commit, so a severed one leaves its edits behind the same way
 * either does. The other executor steps (`branch`, `commit-pr`, `ci`, `merged`)
 * act at the integration point through `git`/`gh` calls and leave no working-tree
 * diff; the judgment steps (`explore`, `plan`, `step-back`) leave nothing;
 * `handoff` writes a comment, not code.
 *
 * `lens-fix` is what #1391 added. The account read `develop` alone, so a lost
 * fixer was described as restarting "from the beginning" while its files sat in
 * the very tree the retry then dispatched into — and the next thing to read
 * those files was the reposition guard that parked the cycle.
 *
 * The retry's tree clean (task-b, in the step router) and this line both key on
 * this set, so a step cannot be cleaned without being accounted for.
 */
export const WORKTREE_EDITING_STEPS: readonly WorkStep[] = ["develop", "lens-fix"];

/** Does a lost attempt of this step leave files in a worktree? */
export function stepEditsWorktree(step: WorkStep): boolean {
  return WORKTREE_EDITING_STEPS.includes(step);
}

/**
 * #1391 — the tree account a retry carries: what the driver found in the lost
 * attempt's tree, and what became of it. The shape is declared once in
 * `workflow-state-schema-retry-tree.ts` (it is persisted on `pipelineState`) and
 * re-exported here, so the line, the cleaner and the schema read one definition.
 */
export type { RetryTreeAccounting } from "./workflow-state-schema-retry-tree.ts";
import type { RetryTreeAccounting } from "./workflow-state-schema-retry-tree.ts";

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
 * attempt that FAILED (1-based). The closing clause says where the lost
 * attempt's work is, and it is derived rather than asserted:
 *
 *  - a step whose work is files in a worktree (`WORKTREE_EDITING_STEPS`) says
 *    the files are there — they are the only copy, and an operator told
 *    "restarts from the beginning" would go looking for work that is on disk;
 *  - when `tree` is present the driver has just accounted for those files, so
 *    the line names the copy instead: a `savedTo` path is an artifact someone
 *    can open, whereas "kept" with no location is how #109's fix survived only
 *    as a scratch diff nobody did;
 *  - a tree that could not be read says so, rather than implying it was clean.
 */
export function lostAttemptLine(
  step: WorkStep,
  attempt: number,
  e: FailureEvent,
  tree?: RetryTreeAccounting,
): string {
  return `${step} attempt ${attempt} lost: ${spent(e)} — ${keptClause(step, tree)}`;
}

/** The clause after the em dash: where the lost attempt's work is now. */
function keptClause(step: WorkStep, tree?: RetryTreeAccounting): string {
  if (!stepEditsWorktree(step)) return "the step restarts from the beginning";
  if (tree?.outcome === "unreadable") {
    return `its conversation is gone, and the worktree it edits could not be accounted for (${tree.error ?? "git gave no reason"}) — check \`git status\` there before the retry lands on it`;
  }
  if (tree?.outcome === "already-clean") {
    return "its conversation is gone; the worktree it edits held nothing, so nothing was left behind";
  }
  if (tree?.outcome === "saved") {
    const where = tree.savedTo
      ? `saved to ${tree.savedTo}`
      : "saved, but the copy's path was not recorded";
    return `its conversation is gone; ${tree.paths.length} file(s) it left in the worktree were ${where} and the tree was cleared for the retry`;
  }
  // No account: the retry has not looked (or could not — no worktree recorded).
  // Say the plain truth the #1391 log showed instead of the clean-restart claim.
  return "its conversation is gone, files it edited are still in the worktree";
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
