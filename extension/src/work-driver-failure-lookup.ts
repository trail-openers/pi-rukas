/**
 * work-driver-failure-lookup — finding the dispatch failure a step ended on.
 *
 * Split from `work-driver-step-router.ts` (AGENTS.md §12 file-size limit). Pure:
 * reads an event log, returns at most one event, writes nothing.
 *
 * The subtle part is the fan-out, and it is the reason this is a function rather
 * than an inline `[events.length - 1]`: reading only the last event silently
 * mis-classifies a fan-out, and the mis-classification was invisible because
 * both shapes look like `ok: false` to the caller.
 */

import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * The dispatch failure this step ended on, if any.
 *
 * A single-dispatch step ends ON its failure, so the last event is the answer.
 * A FAN-OUT step does not: `runDevelop` finishes by appending a
 * `branch-completed` per workstream and then `branches-converged`, which buries
 * the per-child failures several events back. Reading only the last event
 * therefore classified fan-out failures as nothing at all.
 *
 * Measured consequence: three developers hit a 429 carrying a 59-second
 * retry-after — a delay the taxonomy already knows how to wait out, and does
 * wait out for single dispatches — and the step halted with
 * `transientRetryAttempts: {}`. Never attempted, not exhausted. A transient
 * throttle and "the developer genuinely failed" collapsed into the same
 * `ok:false`, and the cap tripped on the latter's semantics.
 *
 * The scan is bounded by `branches-fanned-out`, the marker that opens the
 * fan-out, so it can never reach back into a previous step. All children must
 * have failed for this to return a failure: if any workstream succeeded, the
 * step's problem is not purely transient and re-running it is not the answer.
 */
export function failureEventOf(events: readonly WorkEvent[]): WorkEvent | undefined {
  const last = events[events.length - 1];
  if (last?.kind === "dispatch-failed" || last?.kind === "dispatch-failed-provider") return last;
  if (last?.kind !== "branches-converged") return undefined;
  if (last.verdicts.some((v: { ok: boolean }) => v.ok)) return undefined;

  let failure: WorkEvent | undefined;
  let refused = false;
  for (let i = events.length - 2; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind === "branches-fanned-out") break;
    // #1016 — a driver refusal is not transient, and a fan-out that contains
    // one is not a transient failure even when a sibling dispatch also failed:
    // re-running it would re-refuse the same workstream. Decline the retry.
    if (e.kind === "branch-completed" && e.refused) refused = true;
    if (!failure && (e.kind === "dispatch-failed" || e.kind === "dispatch-failed-provider")) {
      failure = e;
    }
  }
  return refused ? undefined : failure;
}
