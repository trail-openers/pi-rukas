/**
 * lean/build-prompt — the developer's instructions for the build step.
 *
 * The step's contract with the child is narrow and every sentence below is
 * load-bearing for it: the acceptance tests already exist, they were proved red
 * before anybody wrote the feature, and the child's ONE job is to make them
 * pass. That asymmetry is what the rest of the run depends on — a child that
 * edits a test to green it has destroyed the only evidence the run has, which
 * is why the frozen paths are named individually and named as untouchable
 * rather than summarised.
 *
 * The spec's problem and criteria go in VERBATIM, as in `specify-prompt`: a
 * paraphrase would be a second spec, and the child would be working toward the
 * paraphrase rather than the contract the gate reads.
 *
 * The re-entry block is the second most important part. A build that follows a
 * red `verify` or a red CI is a FIX round, and a child that is not told what
 * failed says "make it work" and re-derives a solution from scratch — usually
 * re-producing the same failure. The reason text is pasted rather than
 * summarised because the gate's own words are the evidence.
 *
 * "Do not commit" is a courtesy, not a guarantee: the step folds, unstages,
 * restores and re-commits whatever the child does anyway (see
 * `build-normalise.ts`). It is said because a child that leaves a clean working
 * tree is easier to reason about than one that made three commits, and because
 * a child that commits tends to commit its own edits to the frozen tests, which
 * the step then has to undo.
 */

import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";
import type { PiSpec } from "./spec.ts";

export interface BuildPromptOpts {
  issue: number;
  spec: PiSpec;
  /** The frozen acceptance test paths, in the order the record holds them. */
  frozenPaths: string[];
  /** Absolute path of the worktree the child works in. */
  worktree: string;
  /** 1-based attempt number, for the "attempt N" framing and the commit subject. */
  attempt: number;
  /** The project's `verify.test` runner template (e.g. `bun run {file}`), if configured. */
  testRunner?: string;
  /** Why this round exists: the `verify:red` or `ci:red` reason, clipped by the caller. */
  reentry?: string;
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

/** Build the kickoff prompt for the build child. */
export function buildPrompt(opts: BuildPromptOpts): string {
  const frozenList =
    opts.frozenPaths.length === 0
      ? "(none — this run froze no tests)"
      : opts.frozenPaths.map((p) => `- \`${p}\``).join("\n");
  const reentry =
    opts.reentry === undefined || opts.reentry.trim() === ""
      ? ""
      : [
          "## Why this round exists",
          "",
          "An earlier round was checked and **failed**. Its gate said:",
          "",
          "```",
          opts.reentry.trim(),
          "```",
          "",
          "Fix THAT. Do not re-derive the feature from scratch and do not assume the previous attempt was right — the failure above is the thing you are answering.",
          "",
        ].join("\n");
  const runner =
    opts.testRunner === undefined || opts.testRunner.trim() === ""
      ? "No project test runner is configured, so run each frozen file with whatever command runs this repository's tests."
      : `The project runs one test file with \`${opts.testRunner}\` — the literal \`${TEST_RUNNER_PLACEHOLDER}\` is replaced by the file's path. Run the frozen files with that command as you work, and keep going until they pass.`;
  return [
    `You are implementing issue #${opts.issue}. The acceptance tests already exist and are committed; your job is to make them pass.`,
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
    `Worktree: \`${opts.worktree}\` — already checked out, and your working directory is already there. This is attempt ${opts.attempt}.`,
    "",
    scopeBlock(opts.spec) +
      [
        "## The frozen acceptance tests — do NOT modify these",
        "",
        frozenList,
        "",
        "These files are the contract. **Do not edit, rename, delete, or replace any of them, and do not add a file that shadows one.** They were proved to fail before the feature existed; a test you weaken to green has not passed anything, and the parent restores every one of them from the commit and treats an edit as the child not doing its job.",
        "",
        "If a frozen test looks wrong to you, say so in your reply. Do not change it.",
        "",
        "## The runner",
        "",
        runner,
        "",
        "## What you write",
        "",
        "The implementation. Source files, fixtures and new tests you need for your own work are fine.",
        "",
        "**Do not touch `.pi/`, `.github/`, `.gitmodules` or `CODEOWNERS`** — those decide what the run's verification means, and the parent reverts them. **Do not commit**: leave your changes in the working tree, staged or not, and the parent makes the commit.",
        "",
        "## What you report",
        "",
        "Reply with what you implemented and how you convinced yourself the frozen tests pass.",
      ].join("\n"),
    "",
    reentry,
  ].join("\n");
}
