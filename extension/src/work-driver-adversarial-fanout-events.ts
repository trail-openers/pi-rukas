/**
 * work-driver-adversarial-fanout-events — the event batch one fan-out pass
 * appends (#485/#486). Split from work-driver-adversarial-fanout.ts
 * (AGENTS.md §12 file-size limit). Pure: outcomes in, WorkEvents out.
 */

import { type AdversarialOutcome, outcomeOf } from "./work-driver-adversarial-types.ts";
import type { WorkEvent } from "./workflow-state.ts";

/**
 * Append per-workstream events in deterministic order: dispatch-completed
 * / dispatch-failed, the per-round verdict records (#485), the
 * per-workstream outcome (#486), then branch-completed for N>1. On
 * re-entry the prior pass's SURVIVOR outcomes (approved / rejected /
 * skipped) are re-emitted here from their prior-outcome records (no
 * completionEvent / failureEvent / records — the events are synthetic,
 * carrying the prior verdict and `roundsExecuted: 0`), so the log stays
 * complete after the splice. The whole batch is spliced at `passStart`
 * — the previous pass's records' position on re-entry — so the fresh
 * records replace them and each workstream's rounds appear exactly once
 * (R1). The previous pass's stale records are dropped: a recovered
 * workstream's stale failure outcome must not sit side-by-side with its
 * fresh APPROVED outcome (W1).
 */
export function outcomeEvents(
  outcomes: readonly AdversarialOutcome[],
  multi: boolean,
): WorkEvent[] {
  const events: WorkEvent[] = [];
  const emitted = new Set<string>();
  for (const o of outcomes) {
    // #1863 — the marker this pass wrote travels WITH the events it precedes.
    // The fan-out's splice replaces the region the write-ahead grew into (the
    // markers are persisted DURING the pass, whose span was captured before it
    // started), so a batch that did not carry them would leave them sitting in
    // the retained tail — AFTER the events reporting their dispatch's outcome.
    // For N=1 the tail is the only event `failureEventOf` reads and `nextStep()`
    // has no `dispatch-failed` branch at all, so a step whose reviewer died fell
    // through the linear table into commit-pr: an unreviewed diff past the
    // adversarial gate. Carried here so the audit record survives the
    // replacement. A pass whose write-ahead itself FAILED never dispatched, so
    // it has no marker to record (`writeAheadFailed` says so with
    // `markerWritten: false`) and its id is not one the region absorbs.
    //
    // #1863 round 2 — the re-emitted record is the SAME record, not a new one.
    // Its `at` and `label` are the ones the fan-out persisted (`markerAt` /
    // `dispatchLabel`, carried on the outcome from the marker itself). An earlier
    // draft fabricated `at: 7` and `label: o.id` here, which made one dispatch
    // look like two with different timestamps and different names, and put a
    // 1970 epoch into a log whose other events are wall-clock — the headless
    // result document derived a 56-year `durationMs` from it. A value this
    // function cannot know must be carried IN, never invented.
    if (o.clearedJobId && o.markerWritten !== false && !emitted.has(o.clearedJobId)) {
      emitted.add(o.clearedJobId);
      // #1863 round 2 — an outcome that claims it wrote a marker MUST say when
      // and under what label. A missing `markerAt` used to be papered over with a
      // `Date.now()` here, which made the re-emitted record differ from the one on
      // disk; refusing loudly beats inventing a timestamp the headless projection
      // then turns into a nonsense `durationMs`.
      if (o.markerAt === undefined || o.dispatchLabel === undefined)
        throw new Error(
          `adversarial outcome ${o.id}: marker ${o.clearedJobId} claims a persisted dispatch-started without its at/label — re-emitting it would fabricate the record`,
        );
      events.push({
        kind: "dispatch-started",
        step: "adversarial",
        role: "adversarial-loop",
        label: o.dispatchLabel,
        jobId: o.clearedJobId,
        at: o.markerAt,
      });
    }
    if (o.completionEvent) events.push(o.completionEvent);
    if (o.failureEvent) events.push(o.failureEvent);
    // #1863 round 2 — one marker per dispatch, and the batch must say so. An
    // outcome carries a single `clearedJobId`, so if it ever produced TWO
    // dispatch events the second would splice in with no marker of its own —
    // the exact shape the ordering rule cannot recover (a step whose tail is a
    // bare marker, or a failure with nothing written ahead of it). The invariant
    // the whole write-ahead rests on is asserted here rather than assumed.
    const dispatchEvents = [
      ...(o.completionEvent ? [o.completionEvent] : []),
      ...(o.failureEvent ? [o.failureEvent] : []),
    ].filter((e) => e.kind.startsWith("dispatch-"));
    if (dispatchEvents.length > 1) {
      throw new Error(
        `adversarial outcome ${o.id}: ${dispatchEvents.length} dispatch events on one write-ahead marker (${o.clearedJobId ?? "none"}) — the batch would splice without one marker per dispatch`,
      );
    }
    const recordsAt = Date.now();
    for (const r of o.records) {
      events.push({
        kind: "adversarial-round",
        at: recordsAt,
        workstreamId: multi ? o.id : undefined,
        round: r.round,
        status: r.status,
        verdictParsed: r.verdictParsed,
      });
    }
    if (multi) {
      const outcome = outcomeOf(o);
      events.push({
        kind: "adversarial-workstream-outcome",
        at: Date.now(),
        workstreamId: o.id,
        outcome,
        roundsExecuted: o.rounds,
        ...(o.errorTail && (o.infra || o.threw) ? { errorTail: o.errorTail } : {}),
        ...(outcome === "approved" && o.passFindings ? { findings: o.passFindings } : {}),
      });
    }
    if (o.branchEvent) events.push(o.branchEvent);
  }
  return events;
}
