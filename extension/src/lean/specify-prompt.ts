/**
 * lean/specify-prompt — the adversary's instructions for the specify step.
 *
 * The step's whole value is that the tests it freezes FAIL on the base code: a test that passes before the
 * feature exists proves nothing about it. Every sentence below that is not logistics exists to make an
 * always-failing stub and an already-green test both useless to the child.
 *
 * The spec's problem and criteria go in VERBATIM — a paraphrase would be a second spec to keep in step,
 * and the child would be tested against the paraphrase.
 */
import { type TestLocation, testDirsNamed } from "./config-test-location.ts";
import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";
import { leanIssueSection } from "./issue-prose.ts";
import { criteriaBlock, scopeBlock } from "./spec-blocks.ts";
import { preservesPromptClause } from "../specify-preserves-prompt.ts";
import type { PiSpec } from "./spec.ts";
import { MAX_TEST_BYTES, MAX_TEST_FILES_PER_CRITERION, MAX_TEST_LINES } from "./test-size.ts";
import { oneLine } from "./text-fence.ts";

export interface SpecifyPromptOpts {
  issue: number;
  spec: PiSpec;
  /** The `verify.test` template, e.g. `bun run {file}`. Undefined = none. */
  testRunner?: string;
  /**
   * Where the project keeps its tests, when `.pi/work.json` says
   * (`verify.testDir` or `verify.testDirs`, + `verify.testGlob`). Undefined = the child chooses.
   */
  testLocation?: TestLocation;
  /** Absolute path of the worktree the child works in. */
  worktree: string;
  /**
   * The attributed drops the boundary made on the PREVIOUS attempt, when this is
   * the one retry (`specify.ts`). Undefined or empty on a first attempt.
   */
  refusal?: string[];
  /**
   * Ask for a submission rather than relist the criteria: the previous attempt
   * ended having called `submit_tests` not once, so its fault is not that a
   * file was wrong but that the step never saw any.
   */
  resubmit?: boolean;
  /**
   * The issue body the step re-read from the forge, rendered as its own section — not "The problem",
   * which is one clipped sentence while the constraints live in the prose around it. Absent or
   * blank, it is not rendered.
   */
  issueBody?: string;
}

/** The most drop reasons {@link refusalFeedback} names; the rest are not repeated. */
const REFUSAL_LINES_MAX = 20;
/** One drop reason, clipped to this many characters before the ellipsis. */
const REFUSAL_LINE_MAX = 300;

/**
 * Why a dropped file is a SIZE refusal, as opposed to a misplaced, duplicated or already-green one: only
 * these sentences describe a file the child can fix by making it smaller. An `lstat` count is not matched —
 * a remedy that fires there teaches the child the rules are arbitrary.
 */
const SIZE_REFUSAL =
  / lines; an acceptance test is at most | bytes; an acceptance test is at most | is not a text file/;

/**
 * The one remedy the retry states that the bullets do not: HOW to fix an over-cap test. A bullet says the
 * numbers and stops there, and {@link TEST_SCOPE_CONTRACT} pushes the other way, so a child that obeyed it
 * had no legal way down and overshot again. The remedy names both numbers and says which two sentences it
 * overrides. It sits OUTSIDE the per-reason clip — inside a bullet it is destroyed by the same characters
 * that hid the reason.
 */
function splitInstruction(reasons: string[]): string {
  if (!reasons.some((reason) => SIZE_REFUSAL.test(reason))) return "";
  return `**This attempt: split each over-long test into at most ${MAX_TEST_FILES_PER_CRITERION} files of at most ${MAX_TEST_LINES} lines each.** For this attempt that supersedes "Write ONE test file for each criterion" and "Prefer one focused file per criterion": both files stay directly in the test folder the contract above names, each prints its own basename, and each is a file you create.`;
}

/**
 * The section a retried adversary reads after the normal prompt: each drop the
 * boundary made on its last submission, attributed (`<criterionId> <path>: <reason>`,
 * see `droppedLabel`), one per line. The child never saw those reasons, so naming
 * them is the whole point of the retry. Identical lines are shown once; past the cap
 * the section says how many it left out.
 */
export function refusalFeedback(reasons: string[]): string {
  if (reasons.length === 0) return "";
  // Deduped before clipping: two reasons that share their first 300 characters
  // are two reasons, and clipping first would show the second as a repeat.
  const lines = [...new Set(reasons)].map((reason) => oneLine(reason, REFUSAL_LINE_MAX));
  const shown = lines.slice(0, REFUSAL_LINES_MAX).map((line) => `- ${line}`);
  const more = lines.length - shown.length;
  return [
    "## Your previous submission was refused",
    "",
    "The parent dropped these submitted tests:",
    "",
    ...shown,
    ...(more > 0 ? [`(+${more} more)`] : []),
    "",
    splitInstruction(reasons),
    "",
    "Fix exactly these problems and call submit_tests again for every criterion. The limits in the contract above still apply.",
  ].join("\n");
}

/** The criteria the child must produce tests for: only `verify: "test"`. */
export function testCriteria(spec: PiSpec) {
  return spec.criteria.filter((c) => c.verify === "test");
}

/**
 * The red-proof contract, stated in both adversary prompts. `specify-proof.ts` classifies a run red only
 * when it exited non-zero **and** its output named the file; anything else is `unclear` and dropped. A
 * project's runner need not echo the path, so the child is told to print it itself. One const, so the two
 * prompts cannot drift in the wording a test pins.
 */
export const RED_PROOF_CONTRACT =
  "**Every test file must print its own file basename when it fails**, e.g. `FAIL AC1-retry.test.ts: expected 3 retries, got 1`, and exit non-zero. The parent counts a file as a real red only when its failure output names that file; a failing file whose output never names it is dropped as unclear and its criterion is left uncovered.";

/**
 * The test-writing scope contract, stated in BOTH adversary prompts for the same reason as
 * {@link RED_PROOF_CONTRACT}.
 *
 * It bounds size by asking for the smallest thing that proves the criterion, and states the three numbers
 * the boundary enforces (all in `test-size.ts`) and where the bytes come from. A number alone is met by
 * padding, so the rule is still the property.
 */
export const TEST_SCOPE_CONTRACT = `**Write the smallest test that proves the criterion fails today and will pass when it is met.** Assert observable behaviour — what the entry point returns, throws, or writes — not the shape of the implementation. Do not test hypothetical misuse, or implementation details the criterion does not name: a criterion that says one parameter was removed is proved by one call and one assertion, not by a file of variants. Prefer one focused file per criterion. A kept test file is at most ${MAX_TEST_LINES} lines and ${MAX_TEST_BYTES} bytes, and a criterion gets at most ${MAX_TEST_FILES_PER_CRITERION} files, so reuse the project's existing test helpers in the test folder rather than rebuilding a harness — the parent drops a longer or larger file and the extra files it cannot use.`;

/**
 * The elicitation section, rendered between {@link TEST_SCOPE_CONTRACT} and the non-test-file fence, and
 * only where there are test criteria. One const, for the same reason as the two above: the kickoff and both
 * retries must tell the child the same rule.
 *
 * The requirements a bench rejected missed were implied rather than unstated, and each was findable in the
 * repository — so the section demands a `path:line` comment and drops anything it cannot ground. Extra
 * CASES open no new file, which would spend the {@link TEST_SCOPE_CONTRACT} quota on an implied case.
 *
 * The examples are deliberately generic: naming a bench defect would hand the child the answer to find.
 */
export const IMPLIED_REQUIREMENTS = `## Implied requirements

Before you freeze your tests, search THIS repository for requirements the issue does not state:

1. Input forms and behaviours the code you touch ALREADY supports and the change must keep working with — an optional argument's existing default, a value form older callers still pass.
2. How the new behaviour interacts with existing state, modes and callers — a caller that already depends on the current return value, state another code path set first.
3. Scope the issue implies but never says — which inputs, platforms or call sites the change is meant to cover, which path is the default.

For each one you can point at, add an extra test CASE inside the test file of the criterion it refines, opening no new file for it, with a comment naming the base-commit evidence as \`path:line\`. An implied case never replaces or displaces the criterion's own test. Skip any you cannot ground in a file that exists at the base commit — no evidence, no case.`;

/** The helpers sentence for both adversary prompts (the first 12 names), or "" when the base holds none. */
function testHelpersInstruction(loc: TestLocation): string {
  const named = (loc.helpers ?? []).slice(0, 12).map((h) => `\`${h}\``);
  if (named.length === 0) return "";
  return `**Shared test code already exists at the base commit: ${named.join(", ")}.** Pull the setup a test needs from it (import it, or \`mod\`/\`use\` it) rather than rebuilding a harness inside the test file: a rebuilt harness is what pushes a test past the line cap.`;
}

/**
 * The one place the test-location sentence is spelled, for BOTH adversary prompts (same reasoning as
 * {@link RED_PROOF_CONTRACT}). A builder rather than a const because the folder comes from config. Everything
 * the boundary later refuses is stated here first, so a child that obeyed the prompt meets no unwarned drop.
 */
export function testLocationInstruction(loc: TestLocation): string {
  const helpers = testHelpersInstruction(loc);
  const where = `${testDirsNamed(loc, "`")}${loc.testDirs.length > 1 ? " (whichever holds the tests of the code the test exercises)" : ""}`;
  return `**Write every test file directly inside ${where}, named to match \`${loc.testGlob}\` (for example \`${loc.testDirs[0]}/${exampleName(loc)}\`), importing the project's code with paths relative to that folder.** The parent refuses a submitted test anywhere else — a different directory, a subdirectory of it, or a file name that does not match the pattern — and a refused test leaves its criterion uncovered.${helpers === "" ? "" : ` ${helpers}`}`;
}

/**
 * A sample file name for the prompt: the glob with its `*` filled in, so the example the child copies is
 * always a name the boundary would accept.
 */
function exampleName(loc: TestLocation): string {
  return loc.testGlob.replace("*", "AC1-example");
}

/** The naming line, with the configured folder in the example when there is one. */
export function namingLine(testLocation?: TestLocation): string {
  const example =
    testLocation === undefined
      ? "`tests/AC1-<slug>.test.ts`"
      : `\`${testLocation.testDirs[0]}/${exampleName(testLocation)}\``;
  return `Name each file so its path contains the criterion id it covers (e.g. ${example} for AC1) — the parent matches files to criteria by that id.`;
}

/**
 * The note a re-prompted adversary reads when its previous turn never called
 * `submit_tests`. Fixed text: the step does not inspect what the child wrote,
 * so no child-authored string — a path, a file name — enters the prompt.
 */
const RESUBMIT_NOTE =
  "## Your previous turn ended without calling submit_tests\n\nYour tests are not the step's until you declare them. Write your red test files again if the tree no longer holds them, and call `submit_tests` for every criterion listed above. Do not end the turn without it.";

/** Build the kickoff prompt for the specify child. */
export function specifyPrompt(opts: SpecifyPromptOpts): string {
  const tests = testCriteria(opts.spec);
  const runner =
    opts.testRunner === undefined
      ? "No project test runner is configured, so run each file directly and report the command you used in `note`."
      : `The parent runs each file with the project template \`${opts.testRunner}\` — the literal \`${TEST_RUNNER_PLACEHOLDER}\` is replaced by the file's path, so the file must be executable by that command alone.`;
  const issueSection = leanIssueSection(opts.issueBody);
  const prompt = [
    `You are writing the ACCEPTANCE TESTS for issue #${opts.issue}, before anybody implements it.`,
    "",
    "## The problem",
    "",
    opts.spec.problem,
    "",
    // The issue section sits between the problem and the criteria: the child
    // reads the task statement before the list it must prove. An empty section
    // contributes no line at all, so a body with nothing to say leaves no gap.
    ...(issueSection === "" ? [] : [issueSection, ""]),
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
        tests.length === 0 ? "" : preservesPromptClause(),
        "",
        tests.length === 0 ? "" : IMPLIED_REQUIREMENTS,
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
  if (opts.resubmit === true) return `${prompt}\n\n${RESUBMIT_NOTE}`;
  return opts.refusal === undefined || opts.refusal.length === 0
    ? prompt
    : `${prompt}\n\n${refusalFeedback(opts.refusal)}`;
}
