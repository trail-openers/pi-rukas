/**
 * lib/verify-develop-criteria-fixture — the spec-block and runner vocabulary shared by the
 * two #2283 develop-gate suites.
 *
 * `test-work-driver-verify-command-criteria-classic.ts` drives the command-criteria tier and
 * `test-verify-develop-switches.ts` drives its switch. Both need to hand the develop gate an
 * issue body carrying a `pi-spec v1` block with a runnable `verify: "command"` criterion, and
 * both need the same runner template and runner script the tier's own licences accept. When
 * those literals were written out twice, a wording change to the tier's executed-pass note or
 * a tightening of the config validator's argv-shape rule would have broken one suite and left
 * the other asserting the retired form — so they live here once.
 *
 * The criteria themselves are deliberately NOT fixed here: a case names its own, because the
 * interesting assertions are about a criterion the tier refuses or a file it rewrites.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

/** A criterion the tier can run: a plain repo-relative file whose pass condition is green. */
export const GREEN_CRITERION = {
  id: "AC1",
  text: "The existing suite still passes.",
  verify: "command",
  command: "tests/quota.test.ts",
};

/** One criterion's spec block, in the shape `parsePiSpec` accepts. */
export function specBody(criteria: Record<string, unknown>[]): string {
  return `Add a quota check.\n\n\`\`\`pi-spec v1\n${JSON.stringify(
    { problem: "The meter must refuse an over-quota draw.", criteria, size: "S" },
    null,
    2,
  )}\n\`\`\`\n`;
}

/** A runner template the config validator accepts: argv form, one whole-word `{file}`. */
export const RUNNER_TEMPLATE = "sh tests/run.sh {file}";

/** The project's per-file runner: exits 0 unless the file's own bytes say FAIL, and echoes
 * the filename on failure — the shape `runTestFile` needs to call a run red rather than
 * "unclear". argv form, so no shell re-parses the criterion's path. */
export const RUNNER_SCRIPT =
  '#!/bin/sh\nif grep -q FAIL "$1"; then echo "FAILED: $1" >&2; exit 1; fi\nexit 0\n';

/** The `.pi/work.json` the tier reads for its template — the shape `loadWorkConfig` validates. */
export function workJsonWithRunnerTemplate(): Record<string, unknown> {
  return { version: 1, autoMerge: false, budgets: {}, verify: { test: RUNNER_TEMPLATE } };
}
