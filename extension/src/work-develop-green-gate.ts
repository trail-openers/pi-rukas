/**
 * work-develop-green-gate — #1768: the ONE green rule both develop phases
 * apply, and the safety net's eligibility that follows from it.
 *
 * Pre-#1768 each phase asked git itself, AFTER the #622 net had already
 * committed the pass's leftovers: `greenCountsAsWork` ran on a tree the net
 * had just given a commit, so the driver's own recovery commit certified the
 * child's work. orchard cycle-id printed the two halves one second
 * apart — `safety net committed default (d81ce007) — 6 file(s)` beside the
 * child's own `… docs section + test/review_test.sh remain, then the gate.
 * Continuing.`, and `agent done: developer` after both.
 *
 * Now the count comes from the classify seam (`work-develop-green-classify.ts`),
 * which runs before the net and discounts the driver's own commits by subject
 * and by SHA, and each phase calls here instead of asking git again. The
 * ordering is the whole fix and lives in the phases: this module only judges
 * the verdict they were handed, so there is one sentence for "this pass
 * produced no work of its own" in both the independent fan-out and the
 * dependent phase, and the two cannot drift into disagreeing about what a
 * downgrade means.
 *
 * Two outcomes, and the distinction between them is the issue:
 *
 *  - an UNFINISHED pass (the classify seam recorded dirt it left behind) keeps
 *    the seam's own reason — which names the paths — and never reaches the net,
 *    so the work stays on disk for the ONE corrective round
 *    (`work-develop-unfinished-pass.ts`) instead of riding into commit-pr.
 *  - a pass with no own commits and a CLEAN tree has nothing for the net to
 *    recover: that is the pre-existing GREEN_DOWNGRADE, whose reason and
 *    `downgrade` flag `recordDowngrade` owns. It does NOT carry the unfinished
 *    marker, and the caller's own bookkeeping (failed-or-skipped set, verdict
 *    settle) stays where it was — this module records the event and hands back
 *    the verdict.
 */

import { downgradeReason } from "./work-develop-greens.ts";
import { recordDowngrade } from "./work-develop-retry.ts";
import type { WorkstreamVerdict } from "./work-develop-verdict-source.ts";
import type { WorkEvent } from "./workflow-state.ts";

/** A workstream's verdict after the green gate: settled, with the reason the
 *  surface (verdict list, PR body, handoff) will render. */
export interface GreenGateOutcome {
  id: string;
  ok: false;
  reason: string;
  claimed: true;
  noRetry?: true;
}

/**
 * Settle a child-reported green whose worktree holds no commit of the child's
 * own. The caller has already checked `childOwnWork(verdict)`; this records the
 * downgrade and returns the verdict the fan-out settles on.
 *
 * `emit` is the step's `branch-completed` persister (or the dependent phase's
 * equivalent), so the downgrade lands on the event log next to the completion
 * the dispatch closure already emitted — a later resume and the converge gate
 * both read the log, not this return value.
 */
export function settleCommitlessGreen(
  verdict: WorkstreamVerdict,
  emit: (ev: WorkEvent) => void,
): GreenGateOutcome {
  const unfinished = verdict.reason;
  if (unfinished === undefined) {
    // Clean tree, no own commits: the GREEN_DOWNGRADE shape, verbatim.
    recordDowngrade({ emit }, verdict.id, undefined);
    return {
      id: verdict.id,
      ok: false,
      reason: downgradeReason(),
      claimed: true,
      ...(verdict.noRetry ? { noRetry: true as const } : {}),
    };
  }
  // The unfinished branch already recorded its own `branch-completed` with the
  // `unfinished` fragment (work-develop-pass-record.ts), so no second record is
  // emitted here — one event is one finding.
  return {
    id: verdict.id,
    ok: false,
    reason: unfinished,
    claimed: true,
    ...(verdict.noRetry ? { noRetry: true as const } : {}),
  };
}
