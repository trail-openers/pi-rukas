/**
 * work-driver-adversarial-fanout-splice — where a fan-out pass's event batch
 * goes in the step's log, and what the step's LAST event ends up being (#1863).
 *
 * Split from `work-driver-adversarial-fanout.ts` for the AGENTS.md §12 size
 * limit. Pure: log + batch in, event log out. It owns the one invariant the
 * step router depends on — a step that failed ends on its failure event, never
 * on a write-ahead `dispatch-started`.
 */

import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/** The events the step router reads as "this step ended on a failure". */
const DISPATCH_FAILURE_KINDS: ReadonlySet<string> = new Set([
  "dispatch-failed",
  "dispatch-failed-provider",
]);

/** The id of a `dispatch-started`, or undefined for any other event. */
function markerId(e: WorkEvent): string | undefined {
  return e.kind === "dispatch-started" ? (e as { jobId: string }).jobId : undefined;
}

/**
 * Splice one fan-out pass's batch into the step's event log.
 *
 * WHY the tail is the whole point. `failureEventOf`
 * (`work-driver-failure-lookup.ts`) answers from the FINAL event for a
 * single-dispatch step, and `nextStep()` has no `dispatch-failed` branch at all
 * — so a tail that is not a failure falls through the linear table and ADVANCES
 * the cycle. Before this function, an adversarial step whose reviewer died ended
 * on a `dispatch-started`: the write-ahead runs BEFORE the dispatch, so the log
 * the batch is spliced onto ends with that marker, and the batch — carrying the
 * `dispatch-failed` that came after it — was inserted in written order, leaving
 * the marker trailing its own failure. The cycle then walked into commit-pr with
 * no verdict from the gate that exists to stop exactly that.
 *
 * Three decisions, all keyed on `settledMarkers` — the ids THIS fan-out wrote
 * (minted by `writeAheadFor`), which is the only identity that can tell a pass's
 * own marker from a sibling's:
 *
 *  1. **the batch keeps its own markers, drops a sibling's.** A pass's marker is
 *     re-emitted with its events (see `outcomeEvents`), so it survives the
 *     region replacement below; a marker for an id this fan-out did not settle
 *     belongs to a sibling still reviewing — its record in `log` stands and must
 *     not be duplicated. Dropping a live sibling's marker instead would leave
 *     its id in `inFlightJobIds` with no backing event, which
 *     `classifyRunningState` reads as a crash and `detectInconsistencies` calls
 *     corruption.
 *  2. **the replacement region extends over this pass's markers.** They are
 *     persisted DURING the pass, whose span (`passEnd`) was captured before it
 *     started, so keeping `log.slice(passEnd)` re-attaches them behind the
 *     events that report their dispatch's outcome. The scan stops at the first
 *     marker this pass did not settle, leaving a live sibling's record alone.
 *  3. **the batch is ordered so a failure is last.** See
 *     `orderBatchBeforeTail`.
 */
export function splicePassBatch(
  log: WorkState,
  batchSource: readonly WorkEvent[],
  settledMarkers: ReadonlySet<string>,
  passStart: number,
  passEnd: number,
): WorkEvent[] {
  const batch = batchSource.filter(
    (e) => !(markerId(e) !== undefined && !settledMarkers.has(markerId(e) as string)),
  );
  const tail = orderBatchBeforeTail(batch, settledMarkers);
  const replaceEnd = tailReplaceEnd(log, passEnd, settledMarkers);
  return [...log.eventLog.slice(0, passStart), ...tail, ...log.eventLog.slice(replaceEnd)];
}

/**
 * Order a pass's batch so a dispatch it FAILED on is the step's last event, and
 * a pass that did not fail does not end on a bare marker.
 *
 * Deterministic and stable, in three arms:
 *
 *  1. a batch that ENDS on a dispatch failure already states the failure —
 *     returned untouched, so an approved step never has its records reordered;
 *  2. otherwise, if the batch contains a dispatch failure at all (a sibling's
 *     failure buried under an approved sibling's records), the failures move to
 *     the end in batch order — for N=1 the failure IS the whole batch, so this
 *     is the exact fix; for a fan-out it is the shape `failureEventOf` already
 *     reads back through a `branches-converged` tail;
 *  3. otherwise the batch names no dispatch event (a pass whose reviewer never
 *     ran, or whose dispatch events were dropped): this pass's own marker — the
 *     one `settledMarkers` proves it finished — moves to the FRONT, so the tail
 *     is never a bare marker. `beginDispatch` no-ops under
 *     `PI_ENSEMBLE_RESUME=0`, so that shape is reachable in production.
 *
 * A marker in neither set (a sibling still reviewing) is left in place.
 */
export function orderBatchBeforeTail(
  batch: readonly WorkEvent[],
  settledMarkers: ReadonlySet<string>,
): WorkEvent[] {
  if (batch.length === 0) return [...batch];
  const isFailure = (e: WorkEvent): boolean => DISPATCH_FAILURE_KINDS.has(e.kind);
  if (isFailure(batch[batch.length - 1] as WorkEvent)) return [...batch];
  if (batch.some(isFailure)) {
    return [...batch.filter((e) => !isFailure(e)), ...batch.filter(isFailure)];
  }
  const isSettledMarker = (e: WorkEvent): boolean => {
    const id = markerId(e);
    return id !== undefined && settledMarkers.has(id);
  };
  const markers = batch.filter(isSettledMarker);
  if (markers.length === 0) return [...batch];
  return [...markers, ...batch.filter((e) => !isSettledMarker(e))];
}

/**
 * Where the batch's replacement region ENDS: one past the last
 * `dispatch-started` this fan-out settled.
 *
 * The scan STOPS at the first marker this pass did not settle: that one belongs
 * to a sibling still reviewing, whose record in `log` must be left untouched.
 */
export function tailReplaceEnd(
  log: WorkState,
  from: number,
  settledMarkers: ReadonlySet<string>,
): number {
  let end = from;
  for (let i = from; i < log.eventLog.length; i++) {
    const id = markerId(log.eventLog[i] as WorkEvent);
    if (id === undefined) continue;
    if (!settledMarkers.has(id)) break;
    end = i + 1;
  }
  return end;
}

/**
 * The ids this fan-out's passes own: one per settled dispatch. A pass whose
 * write-ahead itself FAILED never dispatched and is excluded — its minted id
 * must not absorb a marker region or claim a dispatch that never ran.
 */
export function settledMarkerIds(
  outcomes: readonly AdversarialOutcome[],
  minted: readonly string[],
): Set<string> {
  const neverDispatched = new Set(
    outcomes.filter((o) => o.markerWritten === false).map((o) => o.clearedJobId),
  );
  return new Set(minted.filter((id) => !neverDispatched.has(id)));
}
