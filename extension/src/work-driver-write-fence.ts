/**
 * work-driver-write-fence — the driver's side of the write fence (#1655): the
 * cycle's running count of refused writes.
 *
 * A refusal is recorded by the child that made it, in the cycle scratch dir
 * (write-fence-log.ts). The driver does not stream that: it recounts the logs
 * at each terminal boundary and step boundary, and stores the total on the cycle
 * state. The recount is idempotent, so a resumed cycle or a repeated boundary
 * cannot double-count. A log it cannot read is kept apart as unreadable: the
 * total is then a lower bound and the handoff says the count is unknown.
 */

import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";
import { countWriteFenceRefusals } from "./write-fence-log.ts";

/** `state` with the cycle's refusal total brought up to date from the scratch dir. */
export async function foldWriteFenceCount(
  ctx: { repoRoot: string; issue: number },
  state: WorkState,
): Promise<WorkState> {
  const { count, unreadable } = await countWriteFenceRefusals(scratchDir(ctx.repoRoot, ctx.issue));
  const pipeline = state.pipelineState;
  if (
    count === (pipeline.writeFenceRefusals ?? 0) &&
    unreadable === (pipeline.writeFenceUnreadable ?? 0)
  ) {
    return state;
  }
  return {
    ...state,
    pipelineState: { ...pipeline, writeFenceRefusals: count, writeFenceUnreadable: unreadable },
  };
}
