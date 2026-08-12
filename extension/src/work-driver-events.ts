/**
 * work-driver-events — recording work the driver did itself.
 *
 * Several steps are mechanized: the driver runs the git and `gh` commands in
 * code rather than asking an ops subagent to narrate them. Downstream readers
 * — `nextStep`, the step router, the handoff renderers — index on
 * `dispatch-completed`, so a mechanized step still has to produce one.
 *
 * `work-driver-commit.ts` got this right: it constructs the event directly.
 * `work-driver-merged.ts` instead called `runSingleDispatch(…, "driver", …)`
 * with a prompt thunk reading *"no dispatch needed — short-circuit"*. That
 * comment described an intention the code did not implement:
 * `runSingleDispatch` really dispatches, and `spawn.ts` throws
 * `Unknown role: driver` because `driver` is not a role.
 *
 * So every successful mechanized merge threw, became `dispatch-failed`,
 * returned before the `merged` event / `restoreCheckout` / worktree teardown,
 * and — `STEP_FAILURE_POLICY.merged` being `HALT` — routed to handoff. The PR
 * was merged on GitHub; the cycle reported failure. On the default happy path.
 *
 * This is the one place that shape is built, so the two mechanized steps cannot
 * drift apart again, and `test-mechanized-no-dispatch.ts` fails if any
 * `runSingleDispatch` call site ever names a non-role.
 */

import { makeRunId } from "./spawn.ts";
import type { WorkEvent } from "./workflow-state-events.ts";
import type { WorkStep } from "./workflow-state.ts";

/** The `dispatch-completed` a mechanized step produces without dispatching. */
export function synthesizeDriverCompletion(opts: {
  step: WorkStep;
  label: string;
  summary: string;
  /** When the mechanized work began, for an honest elapsed time. */
  startedAt: number;
  now: number;
}): Extract<WorkEvent, { kind: "dispatch-completed" }> {
  return {
    kind: "dispatch-completed",
    step: opts.step,
    // Not a spawnable role — deliberately. It marks the work as the driver's
    // own, which is exactly what a reader of the event log needs to know.
    role: "driver",
    jobId: makeRunId(),
    label: opts.label,
    // The driver only synthesizes this after its own work SUCCEEDED; a
    // mechanized failure falls back to the ops dispatch instead.
    ok: true,
    ms: Math.max(0, opts.now - opts.startedAt),
    at: opts.now,
    summary: opts.summary,
  };
}
