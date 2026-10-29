/**
 * lean/specify-prompt — the adversary's instructions for the specify step.
 *
 * The step's whole value is that the tests it freezes FAIL on the base code.
 * A test that passes before the feature exists proves nothing about the
 * feature, so every sentence below that is not logistics exists to make an
 * always-failing stub and an already-green test both useless to the child:
 * the parent runs each file it is told about against the base commit, and a
 * file that exits 0 there is dropped.
 *
 * The spec's problem and criteria go in VERBATIM. A paraphrase would be a
 * second spec to keep in step, and the child would be tested against the
 * paraphrase rather than the contract.
 */

import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";
import type { PiSpec } from "./spec.ts";

export interface SpecifyPromptOpts {
  issue: number;
  spec: PiSpec;
  /** The `verify.test` template, e.g. `bun run {file}`. Undefined = none. */
  testRunner?: string;
  /** Absolute path of the worktree the child works in. */
  worktree: string;
}

/** The criteria the child must produce tests for: only `verify: "test"`. */
export function testCriteria(spec: PiSpec) {
  return spec.criteria.filter((c) => c.verify === "test");
}

function criteriaBlock(spec: PiSpec): string {
  return spec.criteria
    .map((c) => {
      const command = c.command === undefined ? "" : ` (command: ${c.command})`;
      return `- **${c.id}** [${c.verify}] ${c.text}${command}`;
    })
    .join("\n");
}

function scopeBlock(spec: PiSpec): string {
  const lines: string[] = [];
  if (spec.scope?.paths && spec.scope.paths.length > 0)
    lines.push(`- In scope: ${spec.scope.paths.join(", ")}`);
  if (spec.scope?.out && spec.scope.out.length > 0)
    lines.push(`- Out of scope: ${spec.scope.out.join(", ")}`);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}

/** Build the kickoff prompt for the specify child. */
export function specifyPrompt(opts: SpecifyPromptOpts): string {
  const tests = testCriteria(opts.spec);
  const runner =
    opts.testRunner === undefined
      ? "No project test runner is configured, so run each file directly and report the command you used in `note`."
      : `The parent runs each file with the project template \`${opts.testRunner}\` — the literal \`${TEST_RUNNER_PLACEHOLDER}\` is replaced by the file's path, so the file must be executable by that command alone.`;
  return [
    `You are writing the ACCEPTANCE TESTS for issue #${opts.issue}, before anybody implements it.`,
    "",
    "## The problem",
    "",
    opts.spec.problem,
    "",
    "## The acceptance criteria",
    "",
    criteriaBlock(opts.spec),
    "",
    "## Where you work",
    "",
    `Worktree: \`${opts.worktree}\` — the base commit, clean. Your working directory is already there.`,
    "",
    scopeBlock(opts.spec) +
      [
        "## What you write",
        "",
        tests.length === 0
          ? 'This spec has no `verify: "test"` criteria, so there is nothing to write. Reply with a single sentence saying so and make no `submit_tests` call.'
          : `Write ONE test file for each \`verify: "test"\` criterion: ${tests.map((c) => c.id).join(", ")}.`,
        tests.length === 0
          ? ""
          : "Each file FAILS on the current code **for the behaviour the criterion states** — exercise the real entry point and assert the real expected result. A file that always fails (assert false, an import of a module that does not exist, a syntax error, a skipped or TODO test) is worthless here and will be thrown out: the parent runs every file it is given against the base commit and keeps only those that fail for a real reason.",
        tests.length === 0
          ? ""
          : "Name each file so its path contains the criterion id it covers (e.g. `tests/AC1-<slug>.test.ts` for AC1) — the parent matches files to criteria by that id.",
        "",
        "**Do not edit, create or delete any non-test file.** No source changes, no config, no fixtures outside your test files, no package-manifest edits. The parent reverts anything you touch that you did not submit as a test.",
        "",
        "## How the parent runs your tests",
        "",
        runner,
        "",
        "## What you report",
        "",
        tests.length === 0
          ? "Nothing."
          : `Call \`submit_tests\` exactly ONCE per criterion listed above, with that criterion's id and the path(s) of the file(s) you wrote for it, relative to the worktree. One call per criterion — a criterion you do not report is treated as having no tests and fails the step.`,
        "Do not run the implementation. Do not try to make the tests pass.",
      ].join("\n"),
  ].join("\n");
}
