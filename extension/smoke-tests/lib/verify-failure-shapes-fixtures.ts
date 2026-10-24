/**
 * #1762 — the shared fixtures for the failure-shape smoke suite.
 *
 * Split out of `test-verify-failure-shapes-1762.ts` (AGENTS.md §12 file-size
 * limit): the suite is one table of runner dialects and the same synthetic
 * output is asserted from several angles, so both files name the command, the
 * cwd and the project-runner summary block. A fixture duplicated in two files is two
 * fixtures that can quietly disagree, so neither file re-types them.
 *
 * Not a test: no assertions here, so the offline loop never runs it alone.
 */

/** The command the harness builder composes with (same shape as the
 * `test-work-driver-corrective-decide.ts` fixtures). */
export const CMD = "sh check.sh";

/** The worktree path the harness builder composes with. */
export const WT = "/repo/.worktrees/issue-1-a";

/** The project runner's summary block — the failing stage's own tally. */
export const CHECKS_BLOCK = "scripts/test.sh: failed checks (1)";

/** The line that block prints directly beneath its tally. */
export const CHECK_DETAIL = "scripts/test.sh   pack_release_test.sh";

/**
 * #1762 — a `FAILED:` marker that CARRIES the assertion in its detail, which is
 * the shape the blanket `/^FAILED:/` veto used to refuse along with the bare
 * filename. The `:` inside the detail is deliberate: it is what forces the
 * reader to anchor the path/detail split on the FIRST `: ` after the path rather
 * than on any colon.
 */
export const PAYLOAD_MARKER =
  "FAILED: test/a_test.sh: a first run writes the settings: expected '0', got '1'";

/** The two names a script's tally block prints indented beneath its count. */
export const TALLY_NAMES = ["lint", "test/b_test.sh"];

/** The tally line those names sit under (count 2, matching TALLY_NAMES). */
export const TALLY_LINE = "test.sh: failed checks (2), not run (0)";

/**
 * The whole example stream: the tally, its two indented names, then the payload
 * marker. Synthetic output of a project gate, not this repo's own loop dialect.
 */
export const EXAMPLE_STREAM = [
  TALLY_LINE,
  `    ${TALLY_NAMES[0]}`,
  `    ${TALLY_NAMES[1]}`,
  PAYLOAD_MARKER,
].join("\n");

/** Passing tallies from the same stream — none may surface as evidence. */
export const PASSING = [
  "pack_release_test.sh: 36 cases, 0 failed",
  "sandbox_test.sh: 36 cases, 0 failed",
  "console_test.sh: 36 cases, 0 failed",
];

/** The timing block such a stream prints after its tallies. */
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
