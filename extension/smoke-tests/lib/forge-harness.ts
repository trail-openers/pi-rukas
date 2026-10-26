/**
 * The check runner shared by the GitHub forge adapter's smoke tests.
 *
 * `test-forge-github.ts` and `test-forge-github-labels.ts` (split from it for
 * the §12 size cap) both report per-case results and both must end with a
 * non-zero exit when any case failed. A copy of the runner in each file is the
 * one thing in that split that could fail silently: a `exitCode` that a second
 * copy forgets to set turns a red case green. So it lives here once, and the
 * caller reads it back with `forgeExitCode()`.
 */

let exitCode = 0;

/** Run one case, reporting ok/FAIL without stopping the run. */
export function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

/** Throw with `msg` when `cond` is falsy — the assertion `check` cases use. */
export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/**
 * Finish the run: exits non-zero if any case failed, with a line naming it. A
 * file that ran cases and never called this reported success on red cases, so
 * every caller ends with it.
 */
export function forgeExitCode(label: string): void {
  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log(label);
}
