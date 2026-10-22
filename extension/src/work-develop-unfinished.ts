/**
 * work-develop-unfinished — #1768: the park for a develop pass that ended with
 * uncommitted work and no commit of its own, after its ONE corrective pass.
 *
 * The DECISION lives in `work-develop-own-commit.ts` (`requireOwnCommit`:
 * commits > 0 is the child's own work, dirt with no commit is UNFINISHED) and
 * so does the cap's name. This file holds the STEP-level consequence, beside
 * the crash park its shape mirrors: `work-develop-topological.ts` sits at the
 * §12 cap and the rule needs to be read next to the record it emits, so the
 * park has its own home rather than a second hand-written copy inside the step.
 *
 * Not the crash park: a crash is an infrastructure fault, this is unfinished
 * WORK the child called done, so the operator finishes it or splits the issue.
 */
import * as lifecycle from "./lifecycle-events.ts";
import { trace } from "./trace.ts";
import { DEVELOP_INCOMPLETE_UNCOMMITTED } from "./work-develop-own-commit.ts";
import { namePaths } from "./work-develop-paths.ts";
import { boundJoinFailures } from "./work-develop-cap-evidence.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * Park the workstreams whose develop pass ended with uncommitted paths and no
 * commit of its own; `undefined` when none needs parking, and the caller then
 * proceeds to the crash park, the converged emit and the gates as before.
 *
 * The cap must be the event-log TAIL — `nextStep` routes the cycle on it — so
 * the caller parks BEFORE the safety net and the verify gate: both append
 * events after this one, and the gate's own cap for a dirty, uncommitted tree
 * would displace the cap that actually names what the child left behind.
 */
export function parkUnfinishedDevelop(
  state: WorkState,
  unfinished: ReadonlyMap<string, string[]>,
  issue: number,
): WorkState | undefined {
  if (unfinished.size === 0) return undefined;
  const named = [...unfinished.entries()].map(([id, p]) => `${id}: ${namePaths(p)}`).join(" | ");
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
