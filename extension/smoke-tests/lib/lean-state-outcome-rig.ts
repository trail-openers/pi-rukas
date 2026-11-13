/**
 * lib/lean-state-outcome-rig — the seed writer the `lean/state-outcome` cases share.
 *
 * One record shape, two files: the parent file
 * (`test-lean-state-outcome.ts`) pins which step may carry which piece of
 * evidence, and `test-lean-state-outcome-heads.ts` pins the same rule for the four
 * head fields the verified handback writes. Both refuse a record at LOAD, so both
 * need a seed that is exactly a real run's record plus one forged field — a seed
 * with any other fault would let a refusal that came from somewhere else pass as
 * the rule working.
 *
 * Living in `lib/` rather than in either test is what stops the two drifting: a
 * second copy of the seed is a second definition of "a record this rule should
 * refuse", and only one of them would be checked.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_COUNTERS, leanStateFile } from "../../src/lean/state.ts";
import { FIXTURE_BASE_SHA } from "./lean-engine-fixtures.ts";

/** The clock every step of a seeded run carries, so durations are never the cause. */
export const CLOCK = 1000;

/** One decided step of the shape a real run writes. */
export const STEP = (issue: number, state: string, n: number, kind: string) => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

/**
 * A seed whose ONLY fault is that one evidence-bearing field sits on a step that
 * never produces it. Everything else is the shape a real run writes, so a
 * refusal that came from anything else would be a false alarm.
 */
export function forgedOutcomeField(
  dir: string,
  issue: number,
  step: Record<string, unknown>,
): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: `feature/issue-${issue}`,
    state: "handback",
    counters: INITIAL_COUNTERS,
    steps: [STEP(issue, "ready", 0, "ok"), step],
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}
