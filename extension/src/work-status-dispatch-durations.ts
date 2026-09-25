/**
 * work-status-dispatch-durations — per-DISPATCH durations for status + handoff.
 *
 * Issue #799: the three-hour silent incident (the lens-fix step running while
 * a 6-way adversarial fan-out produced no per-child signal) was reconstructed
 * by hand from event timestamps. The fix is observability in the operator
 * surfaces: `/work-status` (running + terminal) and the handoff markdown
 * should list every dispatch with its own duration, so a slow cycle shows
 * where the time went without opening the state file.
 *
 * This is the SHARED renderer for the "per-dispatch" block in all three
 * surfaces. It reads `dispatch-completed` and `dispatch-failed` (the failure
 * row is the post-mortem view of a dispatch that did NOT complete, and its
 * elapsed is still part of "where the time went") and returns one row per
 * dispatch, in chronological log order.
 *
 * Distinct from `stepTotals` (work-status-events.ts), which rolls up by STEP —
 * per-dispatch rows are the raw signal, per-step totals are the roll-up. A
 * 6-way develop fan-out produces one `develop` row in stepTotals but six
 * dispatch rows here. Both are useful; the operator needs the dispatch-level
 * view for post-mortem and the step view for a compact cycle summary.
 */

import { dispatchTokens } from "./work-driver-cycle-total.ts";
import { fmtElapsed, fmtTokens } from "./work-status-events.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/** One row of the per-dispatch table: label + step + duration (+ tokens if known). */
export interface DispatchDurationRow {
  /** The step identifier ("explore", "develop", "adversarial", "ci", …). */
  step: string;
  /** The label the driver recorded for the dispatch (role, attempt, workstream). */
  label: string;
  /** Elapsed milliseconds for this dispatch, as recorded on its completion event. */
  ms: number;
  /** Tokens for this dispatch (input+output+cacheRead+cacheWrite), 0 if unknown. */
  tokens: number;
  /** `true` when the row comes from a `dispatch-failed`/`-provider` event. */
  failed: boolean;
}

/**
 * Extract one row per dispatch from the event log. Order = log order (chronological).
 * Returns an empty array when the log carries no dispatch events (pre-#534
 * state files and cycles that parked before any dispatch).
 *
 * The `failed` flag distinguishes a dispatch-failed row (which still counts
 * as time spent but not as a successful delivery) from a dispatch-completed row.
 * The renderer emits a ` (failed)` marker for failed rows so an operator can see at a
 * glance that the dispatch did not land.
 */
export function dispatchDurations(events: WorkEvent[]): DispatchDurationRow[] {
  const rows: DispatchDurationRow[] = [];
  for (const e of events) {
    if (e.kind === "dispatch-completed") {
      rows.push({
        step: e.step,
        label: e.label,
        ms: e.ms,
        tokens: dispatchTokens(e),
        failed: false,
      });
    } else if (e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider") {
      rows.push({
        step: e.step,
        label: e.label,
        ms: e.ms,
        tokens: dispatchTokens(e),
        failed: true,
      });
    }
  }
  return rows;
}

/**
 * Render the per-dispatch block as a list of lines, ready to splice into a
 * larger status or handoff report. Returns an empty array when no dispatch
 * rows exist (the caller omits the section entirely in that case, so an
 * empty fixture renders nothing rather than "no dispatches").
 *
 * Each row: `  <step> <label>  <duration>[ · <tokens> tokens][ (failed)]`
 *
 * The column layout matches `stepTotals`'s per-step row (`${step.padEnd(14)}`)
 * so the two sections read as the same table at different granularity.
 * Failed rows carry a trailing ` (failed)` marker so a post-mortem reader
 * can tell at a glance which of the elapsed rows never completed.
 */
export function renderDispatchDurations(events: WorkEvent[]): string[] {
  const rows = dispatchDurations(events);
  if (rows.length === 0) return [];
  return rows.map((r) => {
    const tokens = r.tokens > 0 ? ` · ${fmtTokens(r.tokens)} tokens` : "";
    const failed = r.failed ? " (failed)" : "";
    return `  ${r.step.padEnd(14)} ${r.label} · ${fmtElapsed(r.ms)}${tokens}${failed}`;
  });
}
