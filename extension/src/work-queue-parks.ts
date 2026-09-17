/**
 * work-queue-parks — the #753 deferred-creation park's queue attribution.
 *
 * The `deferred-creation:develop` cap-hit (a dependent workstream's deferred
 * worktree creation refused by a dirty same-issue leftover) parks a cycle in
 * the DEPENDENT phase of the develop step. Two things a generic renderer gets
 * wrong for it, both fixed here:
 *
 *  - the STEP. `parkReason` extracts the step from a cap only when the cap
 *    starts with `step-failed:`; this cap deliberately does not (that prefix
 *    terminalizes as `aborted` — a mid-flight crash — whereas this is a
 *    deliberate park terminalized as `handoff`). Without an explicit mapping
 *    the attribution falls back to `lastCompletedStep`, the last step that
 *    SUCCEEDED (typically `branch`), and the queue summary says the failure
 *    happened at the wrong step.
 *  - the ACTION. The generic fallback tells the operator to `--restart`,
 *    which hits the exact same dirty-leftover refusal. The leftover must be
 *    salvaged first; the action names it.
 *
 * Extracted from work-queue.ts (#398-style seam) because work-queue.ts sits
 * at the 500-line hard cap; the seam is also what lets the smoke tests
 * exercise both halves in isolation.
 */

import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** The step a `deferred-creation:develop` cap-hit attributes to — the
 * dependent phase runs inside the develop step. */
export function deferredLeftoverStep(): string {
  return "develop";
}

/** The operator action for a dirty-leftover park: salvage the leftover
 * before any re-run (the leftover path is carried on the failed workstream's
 * branch-completed event; a re-run before salvage would hit the same refusal). */
export function deferredLeftoverAction(reason: string, primary: number): string {
  const m = reason.match(/deferred-creation:develop(?::(.*))?/);
  const path = m?.[1];
  return `salvage the dirty leftover${path ? ` at ${path}` : ""} (inspect it with git status / git diff, commit or patch the work, then git worktree remove --force -- the leftover path), then re-run /work ${primary} — a plain re-run before salvage would hit the same refusal again`;
}

/** The failed workstream's dirty-leftover leftover path, carried on its
 * branch-completed event — used to name the path in the queue reason. */
export function deferredLeftoverPath(state: WorkState): string | undefined {
  const bc = state.eventLog
    .slice()
    .reverse()
    .find((e): e is Extract<WorkEvent, { kind: "branch-completed" }> => {
      if (e.kind !== "branch-completed" || e.ok !== false) return false;
      return e.deferredCreation?.failure.class === "dirty-leftover";
    });
  const frag = bc?.deferredCreation;
  return frag && frag.failure.class === "dirty-leftover" ? frag.failure.leftoverPath : undefined;
}
