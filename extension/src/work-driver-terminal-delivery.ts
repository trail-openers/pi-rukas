/**
 * work-driver-terminal-delivery — the driver's ONE terminal delivery path.
 *
 * #808 — the terminal line (merged / handoff / aborted) used to be delivered
 * inline in `runWorkDriverInner` while `finalizeCycle` (work-driver-finalize.ts)
 * sat imported-but-uncalled as a second, divergent implementation (it alone
 * carried the `driver-event` envelope on the merged line). Both shapes are
 * collapsed into `deliverTerminalLine` here:
 *
 *  - send FIRST, record `handoffDeliveredAt` only after a successful send.
 *    The pre-#808 write-ahead (write marker → send) turned a delivery throw
 *    into a permanent loss: the guard was already set, so a resume skipped
 *    re-delivery of a line that never arrived.
 *  - the send is wrapped so a throw is traced and NEVER escapes
 *    `runWorkDriverInner` — an escape landed in the async-job rejection path
 *    and was untraced, which is exactly how #765/#782 went silent.
 *  - both terminal kinds carry the `pi-rukas:driver-event v1` envelope on the
 *    first line (the handoff's `renderHandoffUserMessage` already does; the
 *    merged line gains the same envelope it was missing).
 */

import { notifyAgent } from "./agent-message.ts";
import { trace } from "./trace.ts";
import { renderHandoffUserMessage } from "./work-driver-handoff-message.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";

/** Terminal delivery of issue #808's driver. `repoRoot`/`issue` anchor the scratch dir + envelope. */
export type TerminalDeliveryCtx = {
  repoRoot: string;
  issue: number;
  pi: Pick<import("@earendil-works/pi-coding-agent").ExtensionAPI, "sendUserMessage">;
};

/**
 * Deliver the cycle's terminal line (merged / handoff / aborted). Returns the
 * updated state with `handoffDeliveredAt` set — or the input state unchanged
 * when the line was already delivered or the send failed. Never throws.
 */
export async function deliverTerminalLine(
  ctx: TerminalDeliveryCtx,
  state: WorkState,
): Promise<WorkState> {
  const final = state.pipelineState.status;
  if (final !== "merged" && final !== "handoff" && final !== "aborted") {
    return state;
  }

  const alreadyDelivered = state.pipelineState.handoffDeliveredAt !== undefined;
  const message =
    final === "merged"
      ? `pi-rukas:driver-event v1 kind=merged issue=${ctx.issue} at=${new Date().toISOString()}\npi-rukas /work for issue #${ctx.issue} — MERGED ✓`
      : renderHandoffUserMessage(state, ctx.repoRoot, scratchDir(ctx.repoRoot, ctx.issue));

  // The guard is the RESUME guard: skip only when this line demonstrably
  // reached the session, not when it was merely intended to.
  if (alreadyDelivered) {
    trace(`work-driver: terminal line already delivered for #${ctx.issue} — no re-send`);
    return state;
  }

  // #808 — send first, then mark. A throw here (mid-turn race, torn-down
  // session) used to (a) escape into the async-job rejection path untraced
  // and (b) leave a write-ahead marker that made re-delivery impossible.
  // Now the marker stays unset, so a resume retries the send.
  try {
    notifyAgent(ctx.pi, message);
  } catch (err) {
    trace(
      `work-driver: terminal line for #${ctx.issue} FAILED to deliver: ` +
        `${(err as Error).message?.slice(0, 200) ?? err} — handoffDeliveredAt left unset so a resume re-attempts`,
    );
    return state;
  }
  if (final !== "merged") {
    return {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        handoffDeliveredAt: new Date().toISOString(),
      },
    };
  }
  return state;
}
