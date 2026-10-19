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
import {
  clearWriteFenceLogs,
  countWriteFenceRefusals,
  markCountUnknown,
  unscratchedDir,
} from "./write-fence-log.ts";

/**
 * `--restart`: removes the previous cycle's refusal logs so the new count starts
 * at zero. A log that cannot be removed leaves the new count unknown.
 */
export async function resetWriteFenceLogs(scratch: string): Promise<void> {
  const stuck = await clearWriteFenceLogs(scratch);
  if (stuck > 0) markCountUnknown(scratch, stuck);
}

/**
 * `state` with the cycle's refusal total brought up to date from the scratch dir, and
 * the repo's fallback dir (a refusal from a child whose scratch dir was unusable).
 */
export async function foldWriteFenceCount(
  ctx: { repoRoot: string; issue: number },
  state: WorkState,
): Promise<WorkState> {
  const logged = await countWriteFenceRefusals(scratchDir(ctx.repoRoot, ctx.issue));
  const fallback = await countWriteFenceRefusals(unscratchedDir(ctx.repoRoot));
  const count = logged.count + fallback.count;
  const unreadable = logged.unreadable + fallback.unreadable;
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
