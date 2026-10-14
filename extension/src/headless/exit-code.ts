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
 *      --restart, bad arguments, --merge from an agent)
 *
 * A grouped run exits 21 if any issue was interrupted, otherwise the highest
 * per-issue code. The JSON result carries every issue regardless.
 */

import type { WorkCapLiteral } from "../workflow-state-events-caps.ts";
import type { WorkEvent, WorkState } from "../workflow-state.ts";

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
export function lastCap(state: WorkState): string | undefined {
  return lastEvent(state, "cap-hit")?.cap;
}

/** The reason of the most recent `interrupted` event (`signal` or `timeout`). */
export function lastInterruptReason(state: WorkState): string | undefined {
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
    case "interrupted":
      return lastInterruptReason(state) === "timeout" ? EXIT.crash : EXIT.interrupted;
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
