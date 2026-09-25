/**
 * /work workflow state — dispatch-slow event fragment.
 *
 * Issue #799 (operator decision 2026-09-24): when a driver dispatch crosses
 * a slow-run threshold (20 min / 150 turns / 20M tokens, whichever comes
 * first, then each doubling thereafter), the slow-run watch
 * (slow-notice.ts) fires its PM notice + auto-steer AND appends this event
 * to the cycle's state file (via the `onSlow` callback threaded through
 * `dispatchCore`), so `/work-status` and the handoff render it.
 *
 * `dispatch-slow` SUPERSEDES the periodic `dispatch-heartbeat` the earlier
 * #799 attempt introduced: the heartbeat loop never emitted (it awaited the
 * whole dispatch on its first iteration) and a fixed-interval snapshot said
 * nothing about thresholds. One event per crossing, written by the same
 * mechanism that prompts the PM, is the durable record the status surfaces
 * read.
 *
 * Same fragment pattern as the sibling workflow-state-events-*.ts modules:
 * a pure event type composed into the closed `WorkEvent` union in
 * workflow-state-events.ts by name, so the union stays exhaustive and
 * additive (older readers ignore the kind; the schema validator knows it).
 */

import type { WorkStep } from "./workflow-state-events.ts";

/**
 * One bounded threshold crossing of a driver dispatch.
 *
 * Deliberately the scalar fields of `dispatch_peek` (elapsed, turns, tokens)
 * plus the correlation keys — never transcript content, never `lastText`.
 * The PM notice already carries the text snippet in-session; the state file
 * is re-read on every `/work-status`, so it stays to the scalars.
 */
export type DispatchSlowEvent = {
  kind: "dispatch-slow";
  at: number;
  step: WorkStep;
  role: string;
  jobId: string;
  label: string;
  /** Elapsed ms since this dispatch began. */
  elapsedMs: number;
  /** Assistant turns the child had completed at the crossing. */
  turns: number;
  /** Cumulative tokens at the crossing. */
  tokens: number;
};
