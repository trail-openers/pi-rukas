/**
 * oracle-repair-due — whether a blocked verdict earns a repair round, and the only reader of the run's two
 * repair facts. Read off the RUN (the switch stamped at creation, and the spent counter) rather than the
 * environment or the tree, so a resume cannot answer differently and the transition table stays a pure
 * function of `(run, outcome)` — which is what lets the step log be the record of a run.
 */
import type { LeanRun } from "./lean/state.ts";

export function repairRoundDue(run: LeanRun): boolean {
  return run.oracleRepair === true && (run.counters.repairsSpent ?? 0) < 1;
}
