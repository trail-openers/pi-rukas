/**
 * lib/git-range-fixture-exec — the executor the git-range suites hand the module under test.
 *
 * `git-range.ts` takes an `ExecFn`, so every suite that judges its verdicts needs one that
 * really runs git (for the real-repository arms) and one that fails on command (for the
 * killed / signalled / exit-1 arms). Both were written out per suite; the real one is a
 * faithful `execFile` and the fake one is a `throw`, and a suite that quietly built its own
 * could differ in `maxBuffer` or in whether `argv` was honoured at all — which is the exact
 * distinction #1153 is about.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFn } from "../../src/worktree.ts";

const execFileP = promisify(execFile);

/** Run the command for real, honouring the caller's argv / cwd / timeout / maxBuffer. */
export const realExec: ExecFn = async (cmd, opts) => {
  const { stdout, stderr } = await execFileP(cmd, opts?.argv ?? [], {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    timeout: opts?.timeout,
    encoding: "utf8",
  });
  return { stdout, stderr };
};

/** Reject with a caller-supplied error shape — the harness's stand-in for a child that was
 * killed, signalled, or exited non-zero. The fields a verdict turns on (`code`, `killed`,
 * `signal`, `stderr`) are whatever the case names, which is the point: a fixture must be able
 * to say "git's own exit 1" and "the harness's exit 1" distinctly. */
export const failingExec =
  (err: unknown): ExecFn =>
  async () => {
    throw err;
  };
