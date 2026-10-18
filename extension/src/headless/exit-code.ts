/**
 * headless/exit-code — the exit code of a headless run, derived from the state
 * file (headless S4, #1024). The state file is the authority; the process
 * never reports a status it did not read back.
 *
 *   0  merged (or completed with nothing to merge)
 *  10  handoff for any cap other than the clarification caps, or awaiting-human-merge
 *  11  handoff whose cap is intent-park or explore-needs-clarification
 *  20  aborted
 *  21  interrupted by a signal
 *  30  the driver threw, or interrupted by the runner's own --timeout
 *  40  refused to start (claimed by a live cycle, needs-human-attention without
 *      --restart, bad arguments, an unknown flag such as --merge)
 *
 * A grouped run exits 21 if any issue was interrupted, otherwise the highest
 * per-issue code. The JSON result carries every issue regardless.
 */

import type { WorkCapLiteral } from "../workflow-state-events-caps.ts";
import { isProviderPark } from "../workflow-state-events-interrupted.ts";
import type { InterruptReason, WorkEvent, WorkState } from "../workflow-state.ts";

/** Version of the exit-code contract. Bump on any change to the code values or their meanings. */
export const EXIT_CODE_VERSION = 1 as const;

export const EXIT = {
  merged: 0,
  handoff: 10,
  clarification: 11,
  aborted: 20,
  interrupted: 21,
  crash: 30,
  refused: 40,
} as const;

const CLARIFICATION_CAPS = [
  "intent-park",
  "explore-needs-clarification",
] as const satisfies readonly WorkCapLiteral[];

/** The most recent event of `kind` in the state's log, if any. */
export function lastEvent<K extends WorkEvent["kind"]>(
  state: WorkState,
  kind: K,
): Extract<WorkEvent, { kind: K }> | undefined {
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind === kind) return e as Extract<WorkEvent, { kind: K }>;
  }
  return undefined;
}

/** The cap of the most recent cap-hit event, if any. */
export function lastCap(state: WorkState): WorkCapLiteral | undefined {
  const e = state.eventLog[lastCapIndex(state)];
  return e?.kind === "cap-hit" ? e.cap : undefined;
}

/**
 * Index of the most recent cap-hit the cycle stands on, or -1. #1371 — a cap
 * hit by a step the signal then cut off (between that step's `step-started`
 * and an `interrupted` event naming it) is the abort's doing: the driver never
 * routed it, and a resume runs the step again. It is skipped.
 */
export function lastCapIndex(state: WorkState): number {
  const log = state.eventLog;
  let skipping = false;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e?.kind === "interrupted" && e.step !== undefined) skipping = true;
    else if (e?.kind === "step-started") skipping = false;
    else if (e?.kind === "cap-hit" && !skipping) return i;
  }
  return -1;
}

/** The reason of the most recent `interrupted` event (`signal` or `timeout`). */
export function lastInterruptReason(state: WorkState): InterruptReason | undefined {
  return lastEvent(state, "interrupted")?.reason;
}

/** Exit code for one issue's state file. */
export function exitCodeForState(state: WorkState): number {
  switch (state.pipelineState.status) {
    case "merged":
      return EXIT.merged;
    case "handoff": {
      const cap = lastCap(state);
      return cap !== undefined && (CLARIFICATION_CAPS as readonly string[]).includes(cap)
        ? EXIT.clarification
        : EXIT.handoff;
    }
    case "aborted":
      return EXIT.aborted;
    case "interrupted": {
      // #1243 — a provider park is NOT a signal interrupt: nothing was cut off,
      // the handoff was delivered, and the host's contract for a park the
      // endpoint caused is the handoff code it already got (`failure.kind ===
      // "provider"`, re-queueable). It keeps EXIT.handoff so a host that
      // switches on 10 sees no change; only re-entry differs from a `handoff`
      // status. A signal stays 21 and the runner's own `--timeout` stays 30.
      // The test is the shared `isProviderPark`, not a local read of the reason
      // — one discriminator for every surface that has to tell the two apart.
      const reason = lastInterruptReason(state);
      if (isProviderPark(state)) {
        const cap = lastCap(state);
        return cap !== undefined && (CLARIFICATION_CAPS as readonly string[]).includes(cap)
          ? EXIT.clarification
          : EXIT.handoff;
      }
      return reason === "timeout" ? EXIT.crash : EXIT.interrupted;
    }
    default:
      // "running" after the driver returned: the cycle did not terminalize.
      return EXIT.crash;
  }
}

/** Exit code for a grouped run: 21 if any issue was interrupted, else the highest code. */
export function exitCodeForGroup(codes: readonly number[]): number {
  if (codes.includes(EXIT.interrupted)) return EXIT.interrupted;
  return codes.reduce((max, c) => (c > max ? c : max), EXIT.merged);
}
