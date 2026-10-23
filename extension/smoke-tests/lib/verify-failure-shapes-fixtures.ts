/**
 * #1762 — the shared fixtures for the failure-shape smoke suite.
 *
 * Split out of `test-verify-failure-shapes-1762.ts` (AGENTS.md §12 file-size
 * limit): the suite is one table of runner dialects and the same synthetic
 * output is asserted from several angles, so both files name the command, the
 * cwd and the orchard summary block. A fixture duplicated in two files is two
 * fixtures that can quietly disagree, so neither file re-types them.
 *
 * Not a test: no assertions here, so the offline loop never runs it alone.
 */

/** The command the harness builder composes with (same shape as the
 * `test-work-driver-corrective-decide.ts` fixtures). */
export const CMD = "sh check.sh";

/** The worktree path the harness builder composes with. */
export const WT = "/repo/.worktrees/issue-1-a";

/** The orchard summary block — the failing stage's own tally. */
export const CHECKS_BLOCK = "scripts/test.sh: failed checks (1)";

/** The line the orchard block prints directly beneath its tally. */
export const CHECK_DETAIL = "scripts/test.sh   pack_release_test.sh";

/** Passing tallies from the same orchard stream — none may surface as evidence. */
export const PASSING = [
  "pack_release_test.sh: 36 cases, 0 failed",
  "sandbox_test.sh: 36 cases, 0 failed",
  "console_test.sh: 36 cases, 0 failed",
];

/** The timing block a orchard stream prints after its tallies. */
export const TIMING = [
  "slowest checks:",
  "  pack_release_test.sh   21.4s",
  "  sandbox_test.sh        18.9s",
  "total 1314s",
];

/** The assertion helper both suites print through. */
export function makeAssert(): {
  assert: (cond: boolean, msg: string) => void;
  failed: () => boolean;
} {
  let failed = false;
  const assert = (cond: boolean, msg: string): void => {
    if (cond) console.log(`✓ ${msg}`);
    else {
      console.error(`✗ ${msg}`);
      failed = true;
    }
  };
  return { assert, failed: () => failed };
}
