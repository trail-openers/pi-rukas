/**
 * /work workflow state — the `interrupted` + `cycle-interrupted` event types.
 *
 * Moved VERBATIM from workflow-state-events.ts so that file stays under the
 * 500-line gate (AGENTS.md §12); `workflow-state-events.ts` re-exports both
 * types, so importers keep their path. The move is the whole change — the text
 * is byte-identical to the original.
 *
 * The imports are type-only, so this module has no runtime edge: the events
 * module stays free of value imports, which is what keeps the `WORK_STEPS`
 * tuple's home free of the `headless/caps.ts` cycle documented there.
 */
import type { ExitOrigin } from "./workflow-state-events-exit-origin.ts";
import type { WorkEvent, WorkStep } from "./workflow-state-events.ts";
import type { WorkState } from "./workflow-state-schema.ts";

/**
 * Why a cycle was interrupted: the runner's SIGTERM / SIGINT / SIGHUP (`signal`),
 * its own `--timeout` (`timeout`), or a park the model ENDPOINT caused
 * (`provider`, #1243). The one vocabulary for the event field, the abort reason
 * and the exit code (headless/exit-code.ts).
 *
 * `provider` is the one reason no signal writes. A #1243 provider park terminalises
 * as `interrupted` with this reason rather than `handoff`, because `handoff` is
 * terminal: re-entry refuses it without `--restart`, which wipes the state file and
 * rebuilds finished steps. The advice that cap carried said the opposite ("the step
 * resumes where it stopped"), and a cycle the ENDPOINT stopped has nothing for a
 * person to look at — so it is parked in the one status the driver already re-enters
 * for free. `headless/exit-code.ts` maps it to the handoff exit code, so the host
 * contract for a provider park is unchanged; only re-entry is.
 */
export type InterruptReason = "signal" | "timeout" | "provider";

/**
 * #1243 fix round — the ONE test for "is this state a provider park?".
 *
 * A provider park is an `interrupted` state whose `interrupted` event carries
 * reason `provider`, and nothing else. Three surfaces already had to know that
 * (the exit code, the terminal-delivery guard, the queue entry) and each wrote
 * its own reading, which is how the round-2 findings got here: a surface that
 * tested the status alone called the park ABORTED, and one that tested the cap
 * alone would read a signal interrupt as a park. `interrupted` on its own is
 * NOT the answer — a SIGTERM interrupt is `interrupted` too and is neither a
 * handoff exit nor a "parked" row.
 *
 * Lives with the `InterruptReason` type so the vocabulary and its test cannot
 * drift apart. Takes the whole state (not the status/reason pair) because the
 * reason lives on the event, not on `pipelineState`.
 */
export function isProviderPark(state: WorkState): boolean {
  if (state.pipelineState.status !== "interrupted") return false;
  for (let i = state.eventLog.length - 1; i >= 0; i--) {
    const e = state.eventLog[i];
    if (e?.kind !== "interrupted") continue;
    return e.reason === "provider";
  }
  return false;
}

/**
 * S4a (#1162) — the cycle was interrupted (SIGTERM / SIGINT, via
 * `markInterrupted`). `reason` is the operator-facing why; renderers read
 * the most recent `interrupted` event for it. #1371 — `step` is the step the
 * interrupt cut off, set only when the signal fired while that step ran
 * (absent at a step boundary): its own cap-hits are the abort's doing.
 * Moved here from workflow-state-events.ts for the 500-line gate (#1667).
 */
export type InterruptedEvent = {
  kind: "interrupted";
  at: number;
  reason: InterruptReason;
  step?: WorkStep;
};

/**
 * The session was shut down under a running cycle (Pi's `session_shutdown`).
 * NOT a failure and never followed by a cap-hit: status stays `running`, and
 * the next `/work <N>` re-enters `step`.
 */
export type CycleInterruptedEvent = {
  kind: "cycle-interrupted";
  at: number;
  /** The step that was running, or about to start. */
  step: WorkStep;
  /**
   * Pi's shutdown reason. The known values are the `session_shutdown` reasons;
   * `(string & {})` keeps the union open so a new Pi reason is not a type error.
   */
  reason: "quit" | "reload" | "new" | "resume" | "fork" | (string & {});
  /**
   * #1247 — where the shutdown actually came from: a signal (`signal:SIGTERM`),
   * a closed stdin (`stdin-eof`), or `unknown` when nothing observable did. Pi's
   * `reason` field cannot distinguish these, so this is tracked at the process
   * level (exit-cause.ts) and recorded here. The vocabulary is a closed union
   * owned by the schema layer (workflow-state-events-exit-origin.ts), and
   * `validateDiscriminants` refuses an origin outside it. Additive and OPTIONAL:
   * state files written before #1247 have no `origin`, and readers must not
   * assume one.
   */
  origin?: ExitOrigin;
  /** Where the work is, when the cycle had got that far. */
  branch?: string;
  headSha?: string;
  /** False when the state on disk is one the re-entry check refuses. */
  resumable: boolean;
  /** The error text when the step threw during the shutdown (bounded). */
  error?: string;
};
