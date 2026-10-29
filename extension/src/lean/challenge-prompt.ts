/**
 * lean/challenge-prompt — the adversary's instructions for the challenge step.
 *
 * `specify` pays an adversary to write tests NOBODY has implemented. `challenge`
 * pays one to break a builder that claims it finished: the frozen tests are
 * committed, the code now claims to pass them, and the child's job is to find
 * the case that still fails. That difference is the whole prompt, and every
 * sentence below exists to keep the child from doing the two things that make
 * the round worthless — rewriting an existing test, or writing one that already
 * passes.
 *
 * Naming the frozen tests is load-bearing, not courtesy. A child that cannot see
 * what already exists duplicates it (the parent drops the duplicate, but the
 * round is spent) or, worse, edits it to green — which destroys the only evidence
 * the run holds about the builder's work. So the paths are listed individually
 * and named as untouchable, exactly as `build-prompt.ts` does for its builder.
 *
 * The spec's problem and criteria go in VERBATIM, as in the other two prompts:
 * a paraphrase would be a second spec, and each edge case would be tested against
 * the paraphrase rather than the contract the gate reads.
 *
 * An edge case that turns out to pass is worse than not writing it: the parent
 * runs every submitted file against the current head and keeps only the ones that
 * FAIL there, so an always-failing stub and an already-green test both buy the
 * child nothing. That asymmetry is stated plainly rather than hinted at, because
 * a child optimising for "submitted something" produces exactly those two shapes.
 */

import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";
import type { PiSpec } from "./spec.ts";
import { RED_PROOF_CONTRACT } from "./specify-prompt.ts";

export interface ChallengePromptOpts {
  issue: number;
  spec: PiSpec;
  /** The frozen acceptance tests already committed, in the order the record holds them. */
  frozenPaths: string[];
  /** Absolute path of the worktree the child works in. */
  worktree: string;
  /** The project's `verify.test` runner template (e.g. `bun run {file}`), if configured. */
  testRunner?: string;
}

function criteriaBlock(spec: PiSpec): string {
  return spec.criteria
    .map((c) => {
      const command = c.command === undefined ? "" : ` (command: ${c.command})`;
      return `- **${c.id}** [${c.verify}] ${c.text}${command}`;
    })
    .join("\n");
}

/** Build the kickoff prompt for the challenge child. */
export function challengePrompt(opts: ChallengePromptOpts): string {
  const frozenList = opts.frozenPaths.map((p) => `- \`${p}\``).join("\n");
  const runner =
    opts.testRunner === undefined || opts.testRunner.trim() === ""
      ? "No project test runner is configured, so run each file with whatever command runs this repository's tests."
      : `The parent runs each file with the project template \`${opts.testRunner}\` — the literal \`${TEST_RUNNER_PLACEHOLDER}\` is replaced by the file's path, so the file must be executable by that command alone.`;
  return [
    `You are the adversary for issue #${opts.issue}. The implementation has been written and the author claims it works. Your job is to prove that claim wrong with tests.`,
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
    `Worktree: \`${opts.worktree}\` — the current head, with the implementation committed. Your working directory is already there.`,
    "",
    "## The tests that already exist — do NOT modify these",
    "",
    frozenList,
    "",
    "Those are the frozen acceptance tests. The code claims it passes them. **Do not edit, rename, delete or replace any of them, and do not add a file that shadows one.** A frozen test you weaken has not found anything; it has destroyed the evidence the run depends on, and the parent restores every one of them from the commit.",
    "",
    "## What you write",
    "",
    `ADDITIONAL edge-case tests — cases the frozen files above do not cover, each tied to the id of the criterion it exercises (\`${opts.spec.criteria[0]?.id ?? "AC1"}\`, …). Think about what the frozen tests do NOT check: boundaries, empty and single-element inputs, repeated and concurrent calls, an error on the second attempt rather than the first, a value that is almost right, an input ordering nobody tried. The interesting failure is the one the author did not think of.`,
    "",
    "Each new file MUST FAIL against the code as it stands right now, for the behaviour the criterion states — exercise the real entry point and assert the real expected result. The parent runs every file it is given against the current head and keeps only those that fail there: **a test that passes is thrown out**, and so is one that always fails (assert false, an import of a module that does not exist, a syntax error, a skipped or TODO test). If you cannot find a case that fails, say so in your reply and submit nothing — that is a real answer, and it is better than a test that proves nothing.",
    "",
    "Name each new file so its path contains the criterion id it covers (e.g. `tests/AC1-edge-timeout.test.ts` for AC1) — the parent matches files to criteria by that id — and name it something the frozen files above do not already use.",
    "",
    "**Do not edit, create or delete any non-test file.** No source changes, no config, no fixture edits outside your new test files, no package-manifest edits. The parent reverts anything you touch that you did not submit as a test. **Do not commit**: leave your files in the working tree and the parent makes the commit.",
    "",
    "## How the parent runs your tests",
    "",
    runner,
    "",
    RED_PROOF_CONTRACT,
    "",
    "## What you report",
    "",
    "Call `submit_tests` once per criterion you added files for, with that criterion's id and the path(s) of the NEW file(s) you wrote for it, relative to the worktree. Never submit a path from the frozen list above — the parent refuses it.",
  ].join("\n");
}
