/**
 * #799 — the driver's pending slow-event buffer, keyed by the cycle's
 * primary issue. The per-step `onSlow` recorder (via `slowRecorder`) pushes
 * each crossing into ITS cycle's list INSTEAD of folding into a per-site
 * state ref: the list is drained into the cycle's state at the driver's
 * single step-boundary persistence point (work-driver-step-router.ts
 * `routeStepOutcome`, before its first `writeState`), so one crossing lands
 * exactly once in the durable log regardless of which step recorded it (the
 * two broken shapes it fixes: a plan-time recorder that folded into a
 * throwaway ref, and an adversarial fan-out whose ref was never read back).
 *
 * The key is load-bearing, not decorative: up to
 * MAX_PARALLEL_GROUPS_DEFAULT (3) groups run concurrently in one process, and
 * a single shared buffer let cycle A's routeStepOutcome drain cycle B's
 * crossings into A's event log. The registry (work-driver-registry.ts) keys
 * cycles by the primary issue, which is what identifies a cycle uniquely.
 * Each entry is dropped on drain (no unbounded growth) and on cycle end —
 * the handoff step is the terminal step every /work cycle ends in (success
 * goes through it, and the merged step has no dispatch of its own), so
 * `dropSlowEvents` there covers every leftover.
 */

import type { WorkEvent, WorkStep } from "./workflow-state.ts";

import type { OnSlowCallback } from "./slow-notice.ts";

const pendingSlowEvents = new Map<number, WorkEvent[]>();

/** The driver's per-step slow recorder: the `onSlow` callback the driver
 * threads into `dispatchCore`. `issue` is the cycle's primary issue — the
 * buffer key (see above). Pushes the crossing into that cycle's list;
 * persistence is the driver's single drain point (see above). Sync + never
 * throws (the watch also catches, but the contract is sync so the event
 * log stays append-only). */
export function slowRecorder(issue: number, step: WorkStep): OnSlowCallback {
  return (info) => {
    const list = pendingSlowEvents.get(issue) ?? [];
    list.push({
      kind: "dispatch-slow",
      step,
      role: info.role,
      jobId: info.jobId,
      label: info.label,
      elapsedMs: info.elapsedMs,
      turns: info.turns,
      tokens: info.tokens,
      at: info.at,
    });
    pendingSlowEvents.set(issue, list);
  };
}

/** Drain one cycle's pending list (returns it, deletes the entry — an empty
 * or unknown list gives `[]` without touching anything). Called at the
 * driver's step-boundary persistence point, just before `writeState`, so
 * slow events land in the durable log together with the step's own events
 * — and only in THAT cycle's log (a sibling cycle's list is untouched).
 * The events carry their own `at`, so it is acceptable that they land after
 * the step's completion event. */
export function drainSlowEvents(issue: number): WorkEvent[] {
  const list = pendingSlowEvents.get(issue);
  if (!list || list.length === 0) {
    if (list) pendingSlowEvents.delete(issue);
    return [];
  }
  pendingSlowEvents.delete(issue);
  return list;
}

/** Drop one cycle's leftover list without returning it. Called at the
 * handoff step — the terminal step every /work cycle ends in — so a cycle
 * that recorded a crossing no step boundary drained (e.g. a child that
 * outlived the handoff ops bound) cannot leak its events into a later cycle
 * of the same issue. */
export function dropSlowEvents(issue: number): void {
  pendingSlowEvents.delete(issue);
}

/** Test-only: empty the pending buffer (all cycles). */
export function clearSlowEventsForTesting(): void {
  pendingSlowEvents.clear();
}
