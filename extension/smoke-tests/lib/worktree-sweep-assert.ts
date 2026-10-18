/**
 * #1265 — the assertion harness shared by the two worktree-sweep test files.
 *
 * The sweep's coverage sits under the §12 500-line cap as TWO files, split at
 * the seam that matters: `test-work-driver-worktree-sweep.ts` drives the sweep
 * end-to-end through REAL git (the load-bearing evidence — a sweep that decides
 * to act and issues nothing must fail there), and
 * `test-work-driver-worktree-sweep-rules.ts` exercises the decision engine and
 * its actions directly, with no git under it.
 *
 * What they share is only the reporting: the exit-code accumulator and the
 * three assertion forms. It lives here so the two files cannot disagree about
 * what "failed" means, and so neither grows a `process.exit` of its own that
 * the other forgets. `finish()` is the single exit path.
 */

import { type WorkState, initialState } from "../../src/workflow-state.ts";
import { deadPid } from "./worktree-sweep-fixture.ts";

/** A pinned "long ago" for state files whose age must be a fact, not a side effect. */
export const PAST = Date.parse("2026-01-01T00:00:00.000Z");

let exitCode = 0;

export function assertTrue(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}

export function assertFalse(cond: boolean, msg: string): void {
  assertTrue(!cond, msg);
}

export function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual === expected) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}: expected ${String(expected)}, got ${String(actual)}`);
    exitCode = 1;
  }
}

/**
 * A hard stop, for a fixture that could not be laid down at all. A case that
 * cannot set up must not report the assertions it skipped as passes — and must
 * not report them as failures either, because the next reader would chase a
 * sweep bug that is not there. Exit code 2 separates "the fixture broke" from
 * "the code is wrong".
 */
export function failFast(msg: string): never {
  console.error(`✗ ${msg}`);
  console.error("FAILED (fixture could not be constructed — exit 2, not a sweep verdict)");
  process.exit(2);
}

/** Print the verdict and exit with it. Call once, at the end of `runTests()`. */
export function finish(): never {
  console.log(exitCode === 0 ? "\nAll tests passed." : "\nFAILED");
  process.exit(exitCode);
}

/** The `skipped` reasons of a sweep result, joined for failure messages. */
export function skipReasons(res: {
  skipped: { path: string; reason: string }[];
}): string {
  return res.skipped.map((s) => s.reason).join(",");
}

/** The `skipped` list as path → reason, for per-tree assertions. */
export function skipsByPath(res: {
  skipped: { path: string; reason: string }[];
}): Map<string, string> {
  return new Map(res.skipped.map((s) => [s.path, s.reason]));
}

/**
 * A dead-owner, aborted, pre-cap state file: the shape a killed cycle leaves
 * behind, and the one the sweep's Rule 6 (artifact purge) answers.
 *
 * Lives with the harness because BOTH sweep files read one — the end-to-end
 * cases to lay down a leftover, the rules cases to hand `decideSweepAction` a
 * state that is not an object literal wearing a costume.
 */
export function abortedState(issue: number): WorkState {
  return {
    ...initialState(issue, PAST),
    owner: { pid: deadPid(), at: PAST },
    updatedAt: PAST,
    pipelineState: {
      ...initialState(issue, PAST).pipelineState,
      status: "aborted",
      currentStep: "develop",
    },
  };
}

/**
 * A raw state file whose `schemaVersion` is NOT this build's, for the sweep's
 * read-path test (#1265 FIX 8): a file written by a different driver version
 * must fall to the sweep's `state-unreadable` skip, never be read as a current
 * `WorkState`.
 *
 * Built by hand rather than from `initialState`, because the point is a payload
 * the writer would never produce.
 */
export function foreignSchemaStateJson(issue: number, schemaVersion = 99): string {
  return JSON.stringify(
    {
      schemaVersion,
      issue,
      owner: { pid: deadPid(), at: PAST },
      updatedAt: PAST,
      pipelineState: {
        status: "aborted",
        currentStep: "develop",
        worktrees: {},
      },
      eventLog: [],
    },
    null,
    2,
  );
}
