/**
 * lean/build-repair-fields — the ONE rule that decides whether `build`'s record carries the repair round's
 * fields, and the shape of that record.
 *
 * The rule is a fact about the run's own log, not about the environment a dispatch happened to see: the field
 * pair exists so the round can reset its seat and quote the red the driver watched, and the round is the only
 * thing that reads them. A run that never earned one has no reader and must not carry them, so its record is
 * the one the release wrote before the round existed, key order included. That is what lets a golden captured
 * from a tree that never had the round refute an off arm that quietly widened its record — a comparison of two
 * runs of this tree cannot see a field both arms write.
 *
 * The predicate asks the transition table, so there is one statement of "this run earns a round": the switch's
 * reading is stamped at creation and persisted (`state.ts`), and the counter is billed on the edge that enters
 * the step. A run whose log already holds a decided `repair` step has spent its one round, so the record a
 * later blocked round writes carries nothing new — a `verify:red` retry of a run that repaired once is not a
 * second round, and the round that already ran read its fields from the blocked step that bought it.
 */
import { repairRoundDue } from "../oracle-repair-due.ts";
import type { LeanRun } from "./state.ts";

/** The at-head red the driver watched the project's runner print, as the record holds it. */
export interface ExecutedRed {
  path: string;
  cmd: string;
  output: string;
}

/** What the round needs from the blocked step, in the record's own key order. */
export interface BuildRepairFields {
  /** The head this round started from; on `blocked`, the commit the driver ran the named files at. */
  headBefore: string;
  /** The one red the driver ran, with the command that printed it. */
  blockedEvidence?: ExecutedRed[];
}

/**
 * The two fields in record order, or `{}` for a run that earns no round.
 *
 * `evidence` empty means the driver recorded no output, and then no key is written for it rather than an empty
 * one — an empty array is a fact no runner printed.
 */
export function buildRepairFields(
  run: LeanRun,
  headBefore: string,
  evidence: readonly ExecutedRed[],
): Partial<BuildRepairFields> {
  if (!repairRoundDue(run)) return {};
  return {
    headBefore,
    ...(evidence.length === 0 ? {} : { blockedEvidence: [...evidence] }),
  };
}
