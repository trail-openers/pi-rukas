/**
 * lean-handback-cause — what a handback comment says the run ended on (#2667).
 *
 * The reporting step's NEEDING line is a reading of the step log, and the errored-review arm is
 * the shape that had no line at all: the throw's own record is an `error` outcome, not a verdict,
 * and the operator needs the two facts apart — the step never finished, and here is what stopped
 * it. `lean/handback.ts` owns the comment and the order of causes; this module owns the one
 * reading the review throw adds.
 */
import { newestDecidedWorkStep } from "./lean/handback-heads.ts";
import type { Step } from "./lean/state.ts";

/**
 * The cause the run ended on, for the ONE shape that has no cause line of its own: a `review` step that
 * THREW. Its record is an error outcome, not a verdict, and the operator needs the two facts apart — the
 * step never finished, and here is what stopped it. The sentence under the heading is the throw's,
 * unedited.
 *
 * A step that ended the run with a VERDICT is not this reading's subject: a red `verify` or `ci` already
 * spoke for itself, and the readers that quote those verdicts run first. A heading over a verdict the run
 * already named would bury the answer the developer can act on under a restatement of it.
 */
export function endedBy(steps: Step[]): string | undefined {
  const ended = newestDecidedWorkStep(steps);
  if (ended?.state !== "review" || ended.outcome?.kind !== "error") return undefined;
  const reason = ended.outcome.message ?? ended.outcome.reason;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;
  // A bare engine error is not a handoff because nobody said which step owed the work; this says so.
  return `the review did not complete. Why the review did not complete: ${reason}`;
}
