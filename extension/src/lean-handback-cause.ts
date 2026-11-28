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
 * The cause the run ended on: the newest decided WORK step's own reason. A decided `handback`
 * entry is excluded — it is a report, not a cause — and a cause on any other step is one that
 * already spoke for itself. A review that THREW is headed as an incomplete review rather than a
 * verdict; the sentence under the heading is the throw's, unedited.
 */
export function endedBy(steps: Step[]): string | undefined {
  const ended = newestDecidedWorkStep(steps);
  const reason = ended?.outcome?.reason ?? ended?.outcome?.message;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;
  // The reason a bare engine error is not a handoff is that nobody said which step owed the work.
  return ended?.state === "review" && ended.outcome?.kind === "error"
    ? `the review did not complete. Why the review did not complete: ${reason}`
    : reason;
}
