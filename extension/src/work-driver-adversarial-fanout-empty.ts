/**
 * work-driver-adversarial-fanout-empty — the #286 empty-diff short-circuit of
 * the adversarial gate, split from work-driver-adversarial-fanout.ts
 * (AGENTS.md §12 file-size limit: #1634's `readWorktreeDiff` gate pushed the
 * fan-out past the cap).
 *
 * The one place the gate decides that a POSITIVELY proven clean tree needs no
 * reviewer. It is kept apart from the read on purpose: since #1634 the read
 * refuses to answer "empty" for a worktree it could not open, so this is
 * reached only with `{ ok: true }` in hand — a bare `""` that never went
 * through `readWorktreeDiff` must never land here.
 */

import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";

/** `PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP=0` forces a real review of an empty diff. */
export function emptyDiffSkipDisabled(): boolean {
  return process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP === "0";
}

/**
 * The outcome a workstream gets when its diff read succeeded and the tree
 * proved clean: a pass with zero rounds, plus the `adversarial-skipped-empty-diff`
 * completion event and (for a fan-out) the branch-completed event, so the state
 * log still records that this workstream reached the gate.
 */
export function emptyDiffOutcome(a: {
  id: string;
  multi: boolean;
  startedAt: number;
  priorInfra: boolean;
}): AdversarialOutcome {
  return {
    id: a.id,
    ok: true,
    rounds: 0,
    records: [],
    infra: false,
    threw: false,
    skipped: true,
    priorInfra: a.priorInfra,
    completionEvent: {
      kind: "adversarial-skipped-empty-diff",
      at: Date.now(),
      workstreamId: a.id,
    },
    branchEvent: a.multi
      ? {
          kind: "branch-completed",
          step: "adversarial",
          workstreamId: a.id,
          ok: true,
          ms: Date.now() - a.startedAt,
          at: Date.now(),
        }
      : undefined,
  };
}
