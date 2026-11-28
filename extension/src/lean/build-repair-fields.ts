/**
 * lean/build-repair-fields — the ONE rule that decides whether `build`'s record carries the repair round's
 * fields, and the shape of that record.
 *
 * The rule is a fact about the run's own step log, read the way the transition table reads it: the field pair
 * exists so the round can reset its seat to the commit the red was judged at and quote the output the driver
 * watched, and the round is their only reader. A run whose log already holds a decided `repair` step is a run
 * the round ran on — its blocked record is the one the round was built from, and the `verify:red` retry that
 * reaches this step again writes over the same log — so only such a run may hold them.
 *
 * Every other run writes the record the release wrote before the round existed, key order included. That is
 * what lets a golden captured from a tree that never had the round refute an off arm that quietly widened its
 * record: a comparison of two runs of this tree cannot see a field both arms write, and a stamp on the run is
 * not evidence — the round's own verdict in the log is.
 */
import type { LeanState } from "./state.ts";
import type { Step } from "./state.ts";

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
  steps: readonly Step[],
  headBefore: string,
  evidence: readonly ExecutedRed[],
): Partial<BuildRepairFields> {
  if (!steps.some((s) => s.state === ("repair" as LeanState) && s.outcome !== undefined)) return {};
  return {
    headBefore,
    ...(evidence.length === 0 ? {} : { blockedEvidence: [...evidence] }),
  };
}
