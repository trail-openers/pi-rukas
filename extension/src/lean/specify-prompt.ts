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
import type { TestLocation } from "./config.ts";
import type { PiSpec } from "./spec.ts";

export interface SpecifyPromptOpts {
  issue: number;
  spec: PiSpec;
  /** The `verify.test` template, e.g. `bun run {file}`. Undefined = none. */
  testRunner?: string;
  /**
   * Where the project keeps its tests, when `.pi/work.json` says
   * (`verify.testDir` + `verify.testGlob`). Undefined = the child chooses.
   */
  testLocation?: TestLocation;
  /** Absolute path of the worktree the child works in. */
  worktree: string;
}

/** The criteria the child must produce tests for: only `verify: "test"`. */
export function testCriteria(spec: PiSpec) {
  return spec.criteria.filter((c) => c.verify === "test");
}

/**
 * The red-proof contract, stated in both adversary prompts.
 * `specify-proof.ts` classifies a run red only when it exited non-zero **and**
 * its output named the file (the path or the basename); anything else is
 * `unclear` and the file is dropped. A project's own runner is not required to
 * echo the path — this repo's smoke tests print `✗ <message>` and exit 1, and
 * every one of their reds would have read as unclear — so the child is told to
 * print it itself. The proof rule is NOT relaxed for this: the sentence tells
 * the child how to satisfy the rule, it does not change what the rule accepts.
 * One const, so the two prompts cannot drift in the wording a test pins.
 */
export const RED_PROOF_CONTRACT =
  "**Every test file must print its own file basename when it fails**, e.g. `FAIL AC1-retry.test.ts: expected 3 retries, got 1`, and exit non-zero. The parent counts a file as a real red only when its failure output names that file; a failing file whose output never names it is dropped as unclear and its criterion is left uncovered.";

/**
 * The test-writing scope contract, stated in BOTH adversary prompts for the
 * same reason as {@link RED_PROOF_CONTRACT}: one const, so a rewrite to one
 * step's prompt cannot quietly re-tell the other adversary a different rule.
 *
 * The first lean trial's adversary wrote 540 lines to prove that one parameter
 * had been removed — tests for hypothetical misuse and for the shape of the
 * implementation rather than the behaviour the criterion named. The contract
 * bounds the size by asking for the smallest thing that proves the criterion,
 * and deliberately does not name a line count: a number would be met by
 * padding or gaming it, while "smallest test that proves the criterion" is the
 * property the round actually needs.
 */
export const TEST_SCOPE_CONTRACT =
  "**Write the smallest test that proves the criterion fails today and will pass when it is met.** Assert observable behaviour — what the entry point returns, throws, or writes — not the shape of the implementation. Do not test hypothetical misuse, or implementation details the criterion does not name: a criterion that says one parameter was removed is proved by one call and one assertion, not by a file of variants. Prefer one focused file per criterion.";

/**
 * The one place the test-location sentence is spelled, for BOTH adversary
 * prompts — same reasoning as {@link RED_PROOF_CONTRACT}: a rewrite to one
 * prompt must not quietly un-tell the other step's adversary where its files
 * have to go.
 *
 * It is a builder rather than a const because the folder comes from the
 * project's config. Everything the boundary later refuses is stated here first
 * (wrong folder, nested folder, wrong name), so a child that obeyed the prompt
 * never meets a drop it was not warned about.
 */
export function testLocationInstruction(loc: TestLocation): string {
  return `**Write every test file directly inside \`${loc.testDir}/\`, named to match \`${loc.testGlob}\` (for example \`${loc.testDir}/${exampleName(loc)}\`), importing the project's code with paths relative to that folder.** The parent refuses a submitted test anywhere else — a different directory, a subdirectory of it, or a file name that does not match the pattern — and a refused test leaves its criterion uncovered.`;
}

/**
 * A sample file name for the prompt: the glob with its `*` filled in. Derived
 * from the pattern rather than hard-coded, so the example the child copies is
 * always a name the boundary would actually accept.
 */
function exampleName(loc: TestLocation): string {
  return loc.testGlob.replace("*", "AC1-example");
}

/** The naming line, with the configured folder in the example when there is one. */
export function namingLine(testLocation?: TestLocation): string {
  const example =
    testLocation === undefined
      ? "`tests/AC1-<slug>.test.ts`"
      : `\`${testLocation.testDir}/${exampleName(testLocation)}\``;
  return `Name each file so its path contains the criterion id it covers (e.g. ${example} for AC1) — the parent matches files to criteria by that id.`;
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
        tests.length === 0 ? "" : namingLine(opts.testLocation),
        // The newness rule, in the child's own instructions, before the boundary
        // enforces it: the worktree is a checkout of the base, so a tracked test
        // that is already there is reachable and looks like something to submit.
        tests.length === 0
          ? ""
          : "Each file must be a file YOU CREATE: the parent refuses any path that already exists in the base commit, whether you left it untouched or overwrote it — an existing test is not evidence about code nobody wrote yet, and overwriting one rewrites the contract the builder is measured against.",
        tests.length === 0 || opts.testLocation === undefined
          ? ""
          : testLocationInstruction(opts.testLocation),
        "",
        tests.length === 0 ? "" : TEST_SCOPE_CONTRACT,
        "",
        "**Do not edit, create or delete any non-test file.** No source changes, no config, no fixtures outside your test files, no package-manifest edits. The parent reverts anything you touch that you did not submit as a test.",
        "",
        "## How the parent runs your tests",
        "",
        runner,
        "",
        RED_PROOF_CONTRACT,
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
