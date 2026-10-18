/**
 * work-driver-transition-safety — the driver's unbounded-transition guard.
 *
 * Split from work-driver.ts (AGENTS.md §12 file-size limit). The loop in
 * `runWorkDriverInner` is a step-transition table, so a routing bug that keeps
 * answering "run this step again" would spin forever and pay for a dispatch each
 * time. The counter lives at the call site (it is loop state); what lives here
 * is the terminal half — what the cycle becomes when the guard fires — so the
 * loop body stays a transition table rather than a pile of terminal shapes.
 *
 * The guard is a DRIVER BUG signal, not an operator outcome: 64 iterations means
 * a step answered "not done" while a routing decision was pending, the same
 * class as the `running`-on-exit anomaly the loop reports at the end. The state
 * file and the notification are what the operator gets; the trace is what
 * whoever fixes the router gets.
 */

import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { reportFinalState } from "./work-driver-final-state.ts";
import { type WorkState, persistCycle, workStateDir } from "./workflow-state.ts";

/** The iteration count past which the transition loop is considered stuck. */
export const MAX_TRANSITION_ITERATIONS = 64;

/** Abort the cycle, record it, and tell the operator — the guard's terminal half. */
export async function haltOnTransitionSafety(
  ctx: CycleContext,
  state: WorkState,
): Promise<{ started: true }> {
  trace(`work-driver: safety break after 64 iterations for issue ${ctx.issue}`);
  const next = {
    ...state,
    pipelineState: { ...state.pipelineState, status: "aborted" as const },
  };
  await persistCycle(ctx, next);
  notifyAgent(
    ctx.host,
    `pi-rukas /work driver aborted on issue #${ctx.issue}: transition safety limit reached.` +
      `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state.`,
  );
  // The cycle ran and then aborted — its state file is the real outcome.
  reportFinalState(ctx, next);
  return { started: true };
}
