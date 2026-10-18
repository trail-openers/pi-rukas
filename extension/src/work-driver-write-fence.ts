/**
 * work-driver-write-fence — the driver's side of the write fence (#1655): the
 * cycle's running count of refused writes.
 *
 * A refusal is recorded by the child that made it, in the cycle scratch dir
 * (write-fence-log.ts). The driver does not stream that: it recounts the logs
 * at each step boundary (routeStepOutcome) and stores the total on the cycle
 * state. The recount is idempotent, so a resumed cycle or a repeated boundary
 * cannot double-count.
 */

import type { CycleContext } from "./work-driver-context.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";
import { countWriteFenceRefusals } from "./write-fence-log.ts";

/** `state` with the cycle's refusal total brought up to date from the scratch dir. */
export async function foldWriteFenceCount(ctx: CycleContext, state: WorkState): Promise<WorkState> {
  const total = await countWriteFenceRefusals(scratchDir(ctx.repoRoot, ctx.issue));
  if (total === (state.pipelineState.writeFenceRefusals ?? 0)) return state;
  return { ...state, pipelineState: { ...state.pipelineState, writeFenceRefusals: total } };
}
