/**
 * work-driver-finalize — post-loop cleanup and notification for /work driver.
 */

import { notifyAgent } from "./agent-message.ts";
import { renderHandoffUserMessage } from "./work-driver-handoff-message.ts";
import { scratchDir, teardownWorkspaceTmp } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";

export async function finalizeCycle(
  ctx: { repoRoot: string; issue: number; pi: { sendUserMessage: (msg: string) => void } },
  state: WorkState,
): Promise<void> {
  const final = state.pipelineState.status;
  if (final === "merged") {
    await teardownWorkspaceTmp(ctx.repoRoot, ctx.issue);
  }
  const at = new Date().toISOString();
  if (final === "merged") {
    notifyAgent(
      ctx.pi,
      `pi-ensemble:driver-event v1 kind=merged issue=${ctx.issue} at=${at}\npi-ensemble /work for issue #${ctx.issue} — MERGED ✓`,
    );
  } else if (final === "handoff" || final === "aborted") {
    notifyAgent(
      ctx.pi,
      renderHandoffUserMessage(state, ctx.repoRoot, scratchDir(ctx.repoRoot, ctx.issue)),
    );
  }
}
