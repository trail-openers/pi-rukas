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
import type { DriverHost } from "./work-driver-host.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import { foldWriteFenceCount } from "./work-driver-write-fence.ts";
import { type WorkState, isProviderPark } from "./workflow-state.ts";

/** Terminal delivery of issue #808's driver. `repoRoot`/`issue` anchor the scratch dir + envelope. */
export type TerminalDeliveryCtx = {
  repoRoot: string;
  issue: number;
  host: DriverHost;
};

/**
 * Deliver the cycle's terminal line (merged / handoff / aborted). Returns the
 * updated state with `handoffDeliveredAt` set — or the input state unchanged
 * when the line was already delivered or the send failed. Never throws.
 *
 * `park` (#1243 fix round) is the snapshot the interrupted/park decision must
 * be made from. The caller's in-memory copy has been through
 * `reenterInterrupted`, which flips `interrupted` to `running` — so a park
 * decided from it looks like a live cycle and its owed line is silently never
 * delivered. Passing the disk snapshot keeps this function's own reading of the
 * park and of `handoffDeliveredAt` in agreement with the caller's gate, instead
 * of two copies disagreeing about whether there is a park at all.
 */
export async function deliverTerminalLine(
  ctx: TerminalDeliveryCtx,
  stateIn: WorkState,
  park?: WorkState,
): Promise<WorkState> {
  // #1655 — every terminal state passes here, including a resumed cycle's, and
  // neither the handoff step nor a resume reaches routeStepOutcome. Fold the
  // refusal total first, so the handoff line and the returned state carry it.
  const state = await foldWriteFenceCount(ctx, stateIn);
  // Where the interrupted/park facts come from: the caller's snapshot when it
  // gave one, otherwise its own state (every non-resume caller has no separate
  // disk copy to offer).
  const record = park ?? state;
  const final = record.pipelineState.status;
  // #1243 — `interrupted` is included for the provider park only: a park the
  // endpoint caused still owes the operator the handoff line, and the status is
  // the park's own, not a signal's. A SIGNAL interrupt must not come here — its
  // cycle was cut off mid-step, `interruptIfRequested` owns that write, and
  // there is no handoff to announce. `handoffDeliveredAt` already gates a
  // re-send, so a provider park whose line went out is never sent twice. The
  // test is the shared `isProviderPark` (#1243 fix round): three surfaces ask
  // this same question and all three now answer it the same way.
  if (final !== "merged" && final !== "handoff" && final !== "aborted" && !isProviderPark(record)) {
    return state;
  }

  const alreadyDelivered = record.pipelineState.handoffDeliveredAt !== undefined;
  const message =
    final === "merged"
      ? `pi-rukas:driver-event v1 kind=merged issue=${ctx.issue} at=${new Date().toISOString()}\npi-rukas /work for issue #${ctx.issue} — ${mergedLine(state)}`
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
    notifyAgent(ctx.host, message);
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

/**
 * "MERGED ✓" for the driver's own merge. A PR someone else merged during the
 * review is not the driver's merge, and the line must not say it was.
 */
export function mergedLine(state: WorkState): string {
  const ev = [...state.eventLog].reverse().find((e) => e.kind === "merged");
  if (ev?.kind !== "merged" || !ev.mergedByOtherDuring) return "MERGED ✓";
  return `PR #${ev.prNumber} was MERGED by someone else during ${ev.mergedByOtherDuring}; the driver merged nothing and pushed nothing after. Review findings it had not addressed are on the PR or the issue — check them`;
}
