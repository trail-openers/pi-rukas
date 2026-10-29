/**
 * lean/machine test helpers — the source set of the refusal states.
 *
 * Split from `test-lean-machine.ts` for the 500-line gate (AGENTS.md §12).
 * Lives in `lib/` and is never executed on its own: the CI glob only runs
 * `test-*.ts`, and a helper that ran its own cases would report someone
 * else's verdict.
 *
 * `DECLINE_SOURCES` is the whole answer to "when does a run say no, and who
 * says it". It is a `Set` rather than an array because the test asserts a
 * bijection against it — one entry per legal edge, and no edge outside it —
 * and a list would let a duplicated source pass a length check while hiding a
 * missing one.
 */

/** The only (state + outcome) pairs that may reach the reporting state. */
export const DECLINE_SOURCES = new Set(["ready+fail", "specify+no-red-test"]);

import { MAX_BUILD_ATTEMPTS } from "../../src/lean/machine.ts";

/**
 * Every non-terminal state. Listed rather than derived from `OUTCOME_KINDS`
 * on purpose: the test's whole claim is about what the registry declares, so
 * deriving the traversal set from the same registry would let a state that
 * lost its entry vanish from the walk unnoticed. A state added to the table
 * and forgotten here is caught by the sibling test's exhaustive-pair
 * enumeration, which counts the registry's keys, and by the pair count below
 * the walk refusing to see it.
 */
export const NON_TERMINAL_STATES = [
  "ready",
  "specify",
  "build",
  "challenge",
  "verify",
  "publish",
  "review",
  "ci",
  "land",
  "handback",
  "decline",
] as const;

/**
 * The counter combinations a walk must try. The loop guards in the table are
 * the interesting cases — a cap that is one comparison off looks correct at
 * the default counters and only misroutes at the cap — so the caller crosses
 * these with every declared pair instead of trusting `INITIAL_COUNTERS`.
 *
 * `MAX_BUILD_ATTEMPTS + 1` is in the list on purpose. Every comparison in the
 * table that matters is `>=` or `<` against the cap, and an off-by-one that
 * reads `> MAX` instead of `>=` is indistinguishable from the correct rule at
 * every counter value up to and including the cap: only one attempt PAST it
 * shows the difference. A variant set that stopped at the cap would test the
 * cap and miss the bug it exists to prevent.
 */
export function counterVariants(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const buildAttempts of [0, 1, 2, MAX_BUILD_ATTEMPTS + 1])
    for (const challengeDone of [false, true])
      for (const reviewDone of [false, true])
        for (const ciFixUsed of [false, true])
          for (const draft of [false, true])
            out.push({ buildAttempts, challengeDone, reviewDone, ciFixUsed, draft });
  return out;
}
