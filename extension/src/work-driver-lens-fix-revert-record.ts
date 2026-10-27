/**
 * work-driver-lens-fix-revert-record — #1852 review round 2: the record of a
 * lens-fix stray revert that the driver ACTUALLY PERFORMED.
 *
 * `lensFixFenceCheck` (work-driver-lens-fix-fence-gate.ts) reverts one out-of-
 * fence set per round through the caller's `onRevertible` hook and hands the
 * resulting `fix-pass-strays-reverted` event back on its verdict. Until now the
 * ONLY consumer of that event was the refusal path — the `lens-fix-scope` cap-
 * hit's `restoredToRef` / `restoredToPath`. On the `ok: true` path, where the
 * revert succeeded and the re-judged delta is clean, the event was dropped: the
 * round landed with a driver commit that had deleted files from the fixer's
 * worktree, and nothing in the state explained it. Two consequences, both real:
 *
 *   (a) the operator never saw the preserved ref or the patch, so the reverted
 *       content was undiscoverable — the same disclosure the fix pass makes with
 *       `fixPassRevertNote` (work-driver-adversarial-fix.ts, #1846);
 *   (b) `lensFixRevertAlreadyUsed` counts those events off the log, so a retried
 *       adversarial step (the RETRY_ONCE router or the transient retry ladder)
 *       read "this round has reverted nothing" and reverted a SECOND time in the
 *       same round, which is the exact budget the counter exists to enforce.
 *
 * So this module does the one thing the fix pass's call site does: append the
 * event and PERSIST it before any landing arm runs. Persisting there rather
 * than at the next step boundary is not ceremony — `integrateLensFix` and
 * `commitLensFixChanges` are the next calls, they are destructive, and a crash
 * between them and the record is what leaves a worktree with files gone and a
 * state file that says nothing. `appendEvent` is pure, so this is the first call
 * that makes the record durable; every later writer re-persists the same bytes.
 *
 * Split from `work-driver-adversarial.ts` for the 500-line cap, and kept as a
 * pure function taking `persist` so the unit test can prove the ordering without
 * a filesystem: a boolean the test observes between the persist and the first
 * landing-arm read is the only assertion that distinguishes "recorded" from
 * "recorded before the destructive call".
 */

import { fixPassRevertNote } from "./work-driver-fix-pass-revert-step.ts";
import type { FixPassStraysRevertedEvent } from "./workflow-state-events-fix-pass-strays.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * A `fix-pass-strays-reverted` event as the LENS seam speaks it: `source`,
 * `round` and `workstreamId` are the three fields
 * `lensFixRevertAlreadyUsed` matches on, so every writer and every reader of a
 * lens round's revert names the same shape (#1852 round 3 item 3).
 *
 * The three are optional on the underlying event type because the fix pass
 * wrote neither before #1852 — a pre-#1852 record must still load. A LENS seam
 * that leaves one out produces a revert no counter can see, which is why the
 * stamping lives in one function (`stampLensFixRevert`) rather than at each
 * return path.
 */
export type LensFixRevertEvent = FixPassStraysRevertedEvent;

/** What the caller passed to `lensFixFenceCheck` and what it decided. */
export interface LensFixRevertRecord {
  /** The round's review round — the field the counter matches on. */
  round: number;
  /**
   * The workstream the fence judged, or `undefined` when the fence could not
   * attribute the round to a workstream. `lensFixRevertAlreadyUsed` only ever
   * runs for a round with a workstream id, and an event without one can never
   * be counted — recording it is still right (it documents the revert), it just
   * cannot spend a budget it is not read for.
   */
  workstreamId: string | undefined;
  /** The event the gate's `onRevertible` hook produced; absent = no revert ran. */
  revert: FixPassStraysRevertedEvent | undefined;
}

/**
 * Record this round's stray revert on the state and make it durable.
 *
 * `persist` is `persistCycle` at the call site and a recorder in a test; it is
 * awaited before this returns, which is the whole point — the caller's next
 * statement is the first landing arm.
 *
 * Returns the input state untouched when there is nothing to record, so the
 * in-fence round pays no write.
 */
export async function recordLensFixRevert(
  state: WorkState,
  record: LensFixRevertRecord,
  persist: (state: WorkState) => Promise<void>,
  now: number,
): Promise<WorkState> {
  const { revert, workstreamId, round } = record;
  if (revert === undefined || workstreamId === undefined) return state;
  // The gate stamps `source`/`round`/`workstreamId` itself (`revertLensFixStrays`);
  // re-stamping here keeps a caller that wired a bare `revertStraysOnce` outcome
  // into the hook from producing an event the round's counter cannot read — the
  // counter keys on all three (`lensFixRevertAlreadyUsed`).
  const stamped: FixPassStraysRevertedEvent = {
    ...revert,
    workstreamId,
    source: "lens-fix",
    round,
  };
  const withEvent = appendEvent(state, stamped);
  // The prose note is what puts the paths, the ref and the patch in front of the
  // operator on the handoff / PR body (`plumbReports` is the field the handoff
  // renders). Stamped `lens-fix` rather than the fix pass's `develop`, because
  // this is a lens round's revert and the operator reading it needs to know
  // which step deleted the files.
  const noted: WorkState = {
    ...withEvent,
    pipelineState: {
      ...withEvent.pipelineState,
      plumbReports: [
        ...(withEvent.pipelineState.plumbReports ?? []),
        {
          step: "lens-fix",
          role: "driver",
          body: `lens-fix: ${fixPassRevertNote(stamped)}`,
          at: now,
        },
      ],
    },
  };
  await persist(noted);
  return noted;
}
