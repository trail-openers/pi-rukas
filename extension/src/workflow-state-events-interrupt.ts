/**
 * /work workflow state — the interruption vocabulary and the session-shutdown
 * event (#1162, #1247, #1371).
 *
 * Two shapes of "the cycle stopped without finishing", from two different
 * causes, which is why they live together and read differently:
 *
 *  - `InterruptReason` names why the RUNNER stopped: its own SIGTERM / SIGINT /
 *    SIGHUP, or its `--timeout`. That is the vocabulary the `interrupted`
 *    event field, the abort reason and the headless exit code all share
 *    (headless/exit-code.ts).
 *  - `CycleInterruptedEvent` records that the SESSION was shut down under a
 *    running cycle (Pi's `session_shutdown`). That is not a failure: status
 *    stays `running` and the next `/work <N>` re-enters `step`.
 *
 * Split out of `workflow-state-events.ts` for module-size hygiene (AGENTS.md
 * §12): a pure type fragment with no imports of its own, composed into the
 * closed `WorkEvent` union by name, so the union stays exhaustive and additive.
 * `workflow-state.ts` keeps re-exporting `InterruptReason` (its own
 * `interruptReasonOf` / `markInterrupted` helpers are typed with it), so
 * callers outside the event layer keep drawing it from the module they already
 * import.
 */

import type { ExitOrigin } from "./workflow-state-events-exit-origin.ts";
import type { WorkStep } from "./workflow-state-events.ts";

/**
 * Why a cycle was interrupted: the runner's SIGTERM / SIGINT / SIGHUP (`signal`)
 * or its own `--timeout` (`timeout`). The one vocabulary for the event field,
 * the abort reason and the exit code (headless/exit-code.ts).
 */
export type InterruptReason = "signal" | "timeout";

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
