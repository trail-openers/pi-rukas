/**
 * work-driver-commit-pr-events — the event sequence for a successful
 * mechanized commit-pr. Extracted from work-driver-commit.ts to keep
 * that file under the AGENTS.md §12 500-line cap (the #782 flake-recovery
 * event added ~20 lines to the event block).
 *
 * The caller (mechanizedCommitPr) passes the already-PR-created state; this
 * builder appends the event sequence (flake-recovery, step-started,
 * driver-completion) and persists the commitPrRoot / commitShas /
 * consolidationCompleteness fields.
 */

import type { CommitPrRootInspect } from "./work-driver-commit-inspect.ts";
import { synthesizeDriverCompletion } from "./work-driver-events.ts";
import type { IntegrateResult } from "./work-driver-integrate.ts";
import type { WorkState } from "./workflow-state.ts";
import { appendEvent } from "./workflow-state.ts";

/** The successful, non-empty IntegrateResult — the only shape this function handles. */
type NonEmptyIntegrateResult = Extract<IntegrateResult, { ok: true; empty: false }>;

/**
 * Append the event sequence for a successful mechanized commit-pr and
 * persist the pipelineState fields. Returns the updated WorkState.
 *
 * #782 — the flake-recovery event (verify-flake-recovered, step: "commit-pr")
 * is prepended to the sequence when `commitPrFlakeEvidence` is set (the
 * consolidated verify's single bounded re-run recovered from a flake).
 */
export function finalizeCommitPrState(
  state: WorkState,
  now: number,
  startedAt: number,
  ids: string[],
  branchName: string,
  prNumber: number,
  res: NonEmptyIntegrateResult,
  rootState: CommitPrRootInspect,
  commitPrFlakeEvidence: string | undefined,
): WorkState {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "commit-pr" } },
    { kind: "step-started", step: "commit-pr", at: now },
  );
  // #782 — the commit-pr consolidated verify recovered from a flake: emit
  // the audit trail BEFORE the dispatch-completion event so the ordering
  // in the event log matches the temporal order.
  if (commitPrFlakeEvidence !== undefined) {
    next = appendEvent(next, {
      kind: "verify-flake-recovered",
      at: Date.now(),
      step: "commit-pr",
      evidenceTail: commitPrFlakeEvidence,
    });
  }
  // Via the shared builder (work-driver-events.ts): unique jobId — the old
  // inline literal "mechanized" appeared twice per fan-out cycle, making
  // jobId useless as a correlation key (census 2026-09-09).
  next = appendEvent(
    next,
    synthesizeDriverCompletion({
      step: "commit-pr",
      label: "driver:commit-pr",
      summary: `Mechanized commit-pr: consolidated ${ids.length} worktree(s), committed, pushed ${branchName}, opened PR.\npr: ${prNumber}`,
      startedAt,
      now: Date.now(),
    }),
  );
  // #453 — persist cherry-picked commit SHAs so resume can skip them.
  const commitShas = res.commitShas;
  // #728 — also persist the intended-vs-actual completeness diagnostic when
  // the cherry-pick path produced one (see work-driver-commit-completeness.ts).
  return {
    ...next,
    pipelineState: {
      ...next.pipelineState,
      ...(rootState.ok
        ? { commitPrRoot: rootState.state, commitPrRootError: undefined }
        : { commitPrRoot: undefined, commitPrRootError: rootState.error }),
      ...(commitShas ? { commitShas } : {}),
      ...(res.completeness ? { consolidationCompleteness: res.completeness } : {}),
    },
  };
}
