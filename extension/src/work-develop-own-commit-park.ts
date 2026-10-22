/**
 * work-develop-own-commit-park — #1768: the develop step's park for a pass that
 * ended with dirt and no commit of its own.
 *
 * Kept beside nothing else: the crash park lives in work-develop-crash.ts and
 * this is NOT that case. A crash is an infrastructure fault the operator fixes
 * by keeping the host awake; this is unfinished WORK — the child exited 0 and
 * said so itself — and the operator's action is to finish it or split it.
 */
import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { appendEvent, type WorkState } from "./workflow-state.ts";

/** The cap this park emits — one name, so the registrations and the test read it
 *  from here rather than each typing their own copy. */
export const DEVELOP_INCOMPLETE_UNCOMMITTED = "develop-incomplete-uncommitted";

function namePaths(paths: string[]): string {
  if (paths.length === 0) return "(paths could not be read)";
  const shown = paths.slice(0, 10).join(", ");
  return paths.length > 10 ? `${shown} (+${paths.length - 10} more)` : shown;
}

/**
 * Park the workstreams whose develop pass ended with uncommitted paths and no
 * commit of its own, after the one corrective pass in its own worktree. Returns
 * the parked state, or `undefined` when no workstream needs parking (the caller
 * proceeds to the converged emit and the gates as before).
 *
 * The net is NOT the answer here: committing the child's dirt is what made the
 * unfinished pass read as done (orchard #507, #439). The park keeps the tree as the
 * child left it and names the paths, so the handoff says what is missing rather
 * than reporting `agent done: developer` beside a driver commit.
 */
export function parkUnfinishedDevelop(
  state: WorkState,
  unfinished: ReadonlyMap<string, string[]>,
  issue: number,
): WorkState | undefined {
  if (unfinished.size === 0) return undefined;
  const named = [...unfinished.entries()]
    .map(([id, paths]) => `${id}: ${namePaths(paths)}`)
    .join(" | ");
  lifecycle.emitStepNotice(
    "develop",
    `a developer ended its pass with uncommitted work and no commit of its own (${named}); the pass is not counted as done`,
    issue,
  );
  trace(`work-driver: ${DEVELOP_INCOMPLETE_UNCOMMITTED} — ${named}`);
  return appendEvent(state, {
    kind: "cap-hit",
    at: Date.now(),
    cap: DEVELOP_INCOMPLETE_UNCOMMITTED,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence: boundJoinFailures([named]),
  });
}
