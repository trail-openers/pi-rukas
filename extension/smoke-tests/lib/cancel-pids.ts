/**
 * The pid files the fake-`pi` fixtures write, and the only readers the cancel
 * tests use (issue #1382, round 3).
 *
 * WHY THE READER IS GUARDED AND SHARED
 * ────────────────────────────────────
 * The RED control used to read its pids with `Number(readFileSync(...))`,
 * unguarded. `Number("")` and `Number("garbage")` are NaN — and `process.kill
 * (NaN)` and `pollUntilGone(NaN)` are both a verdict on a process that does not
 * exist rather than a failure to name one. A half-written pid file therefore
 * produced a silent false pass ("the sleep was never alive, so the control
 * held") instead of an obvious failure. The reader returns `undefined` for a
 * pid it cannot name, and callers ASSERT on the absence rather than signalling
 * a NaN.
 *
 * It lives here rather than in `test-cancel.ts` because `lib/cancel-escalation
 * .ts` needs it too, and the whole point of guarding it is that no caller can
 * reach for the raw read.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute this (same shape as `lib/cancel-fixture.ts`); coverage comes
 * through the test files that import it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every pid file the cancel fixtures write, as bare names. The list is
 * explicit rather than a directory glob because the directory is shared with
 * the fake `pi` itself — a glob would have to guess which files are pid files,
 * and guessing wrong means the final reaper silently skips a live sleep.
 *
 * Kept in one list so the reaper in `test-cancel.ts`'s `restoreEnv` cannot
 * drift from the set of fixtures: adding a fixture without adding its pid file
 * here leaves an orphan nothing kills, which is the failure this module exists
 * to prevent.
 */
export const FIXTURE_PID_FILE_NAMES = [
  "t1.pid",
  "t2.pid",
  "t2.grand.pid",
  "t2-control.pid",
  "t2-control.grand.pid",
  "t3.pid",
  "t5.pid",
];

/** The pid files of one fixture run, resolved against its fixture directory. */
export function fixturePidFiles(fakeDir: string): string[] {
  return FIXTURE_PID_FILE_NAMES.map((name) => join(fakeDir, name));
}

/**
 * The pids the files hold, in argument order. A file that is missing, empty,
 * or holds anything but a finite positive integer contributes nothing — "not
 * recorded yet" and "recorded garbage" are both absence, and neither is 0.
 */
export function readRecordedPids(...files: string[]): number[] {
  const pids: number[] = [];
  for (const f of files) {
    try {
      const n = Number(readFileSync(f, "utf8").trim());
      if (Number.isFinite(n) && n > 0) pids.push(n);
    } catch {
      // Not written yet — nothing to poll or kill.
    }
  }
  return pids;
}

/**
 * The single pid one file holds, or `undefined` when it holds nothing
 * nameable. Callers assert on the absence rather than signalling a NaN.
 */
export function readRecordedPid(file: string): number | undefined {
  const [pid] = readRecordedPids(file);
  return pid;
}
