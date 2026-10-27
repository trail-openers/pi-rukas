/**
 * work-develop-fence-merge-notes — #1862: the develop merge-and-retry's budget
 * for the self-fence notes it persists, split out of
 * `work-develop-fence-merge.ts` (the AGENTS.md §12 line cap) along the seam the
 * module already had: this owns how many removals the run may DISCLOSE, and
 * nothing here decides whether a merge happens.
 *
 * Why a budget at all, and why per fold:
 *
 *   - The merge removes a fence whenever it folds a sibling in (`foldTwo`'s
 *     self-fence arm). A removal the state file does not name is the disclosure
 *     failure #1862 exists to close, so each fold persists its own notes AS IT
 *     FOLDS — a mid-loop park must not lose what the earlier folds recorded,
 *     which is the same reason the merge, the maps and the events are all
 *     written per iteration.
 *   - `planQuality.unfence.notes` holds to `UNFENCE_NOTES_CAP`, and a merge that
 *     absorbed many workstreams would otherwise print one note per removal with
 *     no bound at all. So the run has ONE budget of `UNFENCE_NOTES_CAP` notes,
 *     spent down fold by fold, and whatever it could not hold is disclosed as a
 *     single count at the end — never dropped in silence.
 *   - The count is the uncapped truth and the notes are the bounded display,
 *     the same contract the plan step's record keeps.
 */

import { FENCE_VIOLATION_CAP } from "./work-develop-fence-recovery.ts";
import { UNFENCE_NOTES_CAP } from "./work-driver-plan-unfence-notes.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";
import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** The one prefix the fold's note builder uses (workstream-fold-self-fence.ts):
 * what names the overflow line as this merge's own disclosure, so an operator
 * reading the persisted notes sees the count beside the notes it replaced. */
const SELF_FENCE_NOTE_PREFIX = "self-fence dropped: ";

/** What the run's note budget remembers between folds. */
export interface SelfFenceNoteBudget {
  /** The notes THIS fold should persist, sliced to what the run may still say. */
  take(drops: readonly UnfenceRecord[]): UnfenceRecord[];
  /** The "+N more" line, or nothing when every removal fit inside the cap.
   * Said at most once for the whole run, at its end. */
  overflowLine(): string | undefined;
}

/**
 * A run's worth of self-fence notes. Built once per merge-and-retry, before the
 * fold loop, and read only at the folds and once after the loop.
 */
export function selfFenceNoteBudget(): SelfFenceNoteBudget {
  let budget = UNFENCE_NOTES_CAP;
  let dropped = 0;
  let persisted = 0;
  let overflow = false;
  return {
    take(drops: readonly UnfenceRecord[]): UnfenceRecord[] {
      dropped += drops.length;
      const keep = drops.slice(0, Math.max(0, budget));
      budget -= keep.length;
      persisted += keep.length;
      if (keep.length < drops.length) overflow = true;
      return keep;
    },
    overflowLine(): string | undefined {
      if (!overflow) return undefined;
      const omitted = dropped - persisted;
      return omitted > 0
        ? `${SELF_FENCE_NOTE_PREFIX}+${omitted} more (cap ${UNFENCE_NOTES_CAP})`
        : undefined;
    },
  };
}

/** #1005 — the cap-hit for a merge-and-retry park/handoff (same cap as #849;
 * the evidence names the merge, per the #1005 acceptance criterion). It lives
 * beside the run's other disclosure builders because both decide only WHAT a
 * park says, never whether one happens. */
export function fenceCapHit(
  state: WorkState,
  evidence: string,
  cap: WorkCapLiteral = FENCE_VIOLATION_CAP,
  /**
   * #1427 — the gate-hang reports the re-run's gate persisted, recorded on the
   * event STRUCTURALLY (the same channel #841 uses for the raw verify logs) so
   * the handoff names the files without regexing a path out of the evidence.
   */
  logPaths?: string[],
): Extract<WorkEvent, { kind: "cap-hit" }> {
  return {
    kind: "cap-hit",
    at: Date.now(),
    cap,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff",
    evidence,
    ...(logPaths !== undefined && logPaths.length > 0 ? { logPaths } : {}),
  };
}
