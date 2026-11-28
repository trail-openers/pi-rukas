/**
 * lean-specify-reprompt-constants — the shared needles of the silent-reprompt pair, split out of
 * `lean-specify-fixture.ts` so the two suites cannot drift apart about what the nudge text or the retry
 * marker is: a pair that disagrees about the needle asserts nothing about the pair.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RUNNER, type RunResult, configWith } from "./lean-specify-fixture.ts";

/** The nudge the re-prompt appends for a child that ended without submitting. */
export const NUDGE = "Your previous turn ended without calling submit_tests";
/** The marker the decline's reason carries when the retry was spent. */
export const RETRY_NOTE = "(after one retry)";
/**
 * The decline a child that never declared a test earns, on the switch-on arm. Its
 * FIRST clause, in every rule it appears in — the same invariant
 * `criterion <id> has no red test` carries — because the decline comment clips each
 * rule and the run's reason is what an operator reads first.
 */
export const NEVER_SUBMITTED = "the child never submitted a test";
/** The marker clause a specify attempt that re-asked its child carries on its reason. */
export const REASKED = "re-asked the child once for";
/** The test path the silent-child cases write and declare. */
export const TEST_REL = "tests/AC1-retry.test.sh";
/** The runner config every silent-child case runs with. */
export const CONFIG = configWith({ fast: "true", test: RUNNER });

/** Write `body` at the cases' test path, as the child's own write would. */
export function writeTest(wt: string, body: string): void {
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, TEST_REL), body, { mode: 0o755 });
}

/**
 * The one assertion every case in the pair shares: a step that THREW has no verdict
 * to inspect, and the case's own asserts would then read a missing outcome rather
 * than the throw. The caller's `assert` is used so a failure lands in its tally.
 */
export function report(r: RunResult, label: string, assert: (c: boolean, m: string) => void): void {
  assert(r.threw === undefined, `${label}: no throw (${r.threw?.message ?? "clean"})`);
}
