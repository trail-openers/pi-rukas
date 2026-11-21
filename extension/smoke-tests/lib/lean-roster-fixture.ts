/**
 * lib/lean-roster-fixture — the roster a scripted green verify has to carry.
 *
 * `engine-facts.ts`'s `landEarned` reads the green `verify` as a RECORD, not only as a verdict
 * kind: a newest green whose `projectRoster` is missing, empty, or names an edited file whose base
 * version failed is refused the merge. So every fixture that scripts its way to `landed` — rather
 * than driving the real gate, which builds the roster itself — has to write one, or the run hands
 * back naming the roster and the case measures the wrong thing.
 *
 * This is the one place that roster is spelled. It lives in a leaf module (no imports but the
 * `Outcome` type, which is erased) so every fixture can reach it: `lean-engine-fixtures.ts` cannot
 * import `lean-verified-handback-step.ts` (that module's own chain reaches the handback rig), and a
 * second copy of "the minimum roster the gate accepts" in each caller is a second definition of what
 * the land gate reads — only the copy a case happens to call would ever be checked.
 *
 * One test that ran, at the caller's base, is the minimum `projectRosterProblem` and `landEarned`
 * both accept: a non-empty `files`, positive `total`/`baseTotal`, and no `editedFiles`. `passed` is
 * deliberately the only name list the fixture fills — `projectRosterProblem` allows it empty (a suite
 * wholly red at the base is a roster, not a hand-back), and a fixture that claimed more than the
 * gate ever observed would be forging the very evidence the land gate exists to demand.
 */

import type { Outcome } from "../../src/lean/state.ts";

/** The one pre-existing test file a scripted roster claims to have run. */
const SUITE_FILE = "tests/suite.test.ts";

/**
 * The roster a scripted green `verify` carries so its run may reach `landed`.
 *
 * `baseSha` must be a full lowercase oid — `projectRosterProblem` refuses anything else, and the
 * roster claims WHICH commit its base run ran at. Pass the same sha the run's `baseSha` holds.
 */
export function landedRoster(baseSha: string): NonNullable<Outcome["projectRoster"]> {
  return {
    baseSha,
    files: [SUITE_FILE],
    passed: [`${SUITE_FILE}::passes`],
    failed: [],
    baseFailed: [],
    total: 1,
    baseTotal: 1,
  };
}

/** A green `verify` outcome that carries a roster — what a scripted happy path queues. */
export function greenWithRoster(baseSha: string): Outcome {
  return { kind: "green", projectRoster: landedRoster(baseSha) };
}
