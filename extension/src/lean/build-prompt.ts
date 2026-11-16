/**
 * lean/build-prompt — the developer's instructions for the build step.
 *
 * The step's contract with the child is narrow and every sentence below is load-bearing for it: the acceptance
 * tests already exist, they were proved red before anybody wrote the feature, and the child's ONE job is to
 * make them pass. A child that edits a test to green it has destroyed the only evidence the run has, which is
 * why the frozen paths are named individually and as untouchable rather than summarised.
 *
 * The spec's problem and criteria go in VERBATIM: a paraphrase would be a second spec, and the child would
 * work toward the paraphrase rather than the contract the gate reads.
 *
 * The re-entry block is the second most important part. A build following a red `verify` or red CI is a FIX
 * round, and a child not told what failed re-derives a solution from scratch — usually re-producing the same
 * failure. The reason text is pasted rather than summarised because the gate's own words are the evidence.
 *
 * "Do not commit" is a courtesy, not a guarantee: the step folds, unstages, restores and re-commits whatever
 * the child does anyway (`build-normalise.ts`).
 *
 * The `report_blocked` sentence is the child's ONLY exit valve for a contract it cannot satisfy: without it a
 * builder that finds two frozen assertions in conflict has nothing to do but probe them until the turn ceiling
 * kills the step. The tool's report is a claim the driver verifies for itself (`build-blocked.ts`).
 */

import { TEST_RUNNER_PLACEHOLDER } from "./config.ts";
import {
  LEAN_BUILD_ISSUE_LEAD,
  leanBuildIssueProseEnabled,
  leanIssueSection,
} from "./issue-prose.ts";
import { criteriaBlock, scopeBlock } from "./spec-blocks.ts";
import type { PiSpec } from "./spec.ts";

/**
 * The builder's scope contract, stated in one paragraph and pinned by `test-lean-build-wiring.ts`.
 *
 * Each of its clauses bounds something a real builder did. It lives in the prompt rather than a gate because
 * the cost is the child's time and the reviewer's attention, neither of which a step measures afterwards.
 */
export const BUILD_SCOPE_CONTRACT =
  "**Make the smallest change that makes the frozen tests pass and satisfies the issue.** Change nothing the issue does not ask for: no guards, validation or handling for callers, inputs or states that cannot occur (if you think one exists, say so in your reply instead of coding for it). Comments say why the code is the way it is, in a line or two — never the history of the change. To check your own work, run only the frozen tests and the project's fast typecheck and lint. **Do not run the project's full test suite** — the verify step runs it, and a long suite here is time the run pays twice.";

export interface BuildPromptOpts {
  issue: number;
  spec: PiSpec;
  /** The frozen acceptance test paths, in the order the record holds them. */
  frozenPaths: string[];
  /** Absolute path of the worktree the child works in. */
  worktree: string;
  /** 1-based attempt number, for the "attempt N" framing and the commit subject. */
  attempt: number;
  /**
   * The frozen files the adversary's challenge round added, when this round follows one. Rendered as
   * its own section so the builder sees which files are NEW to it.
   */
  added?: string;
  /** The project's `verify.test` runner template (e.g. `bun run {file}`), if configured. */
  testRunner?: string;
  /** Why this round exists: the `verify:red` or `ci:red` reason, clipped by the caller. */
  reentry?: string;
  /**
   * The issue body the step read for its own spec parse. The frozen tests were written from this text, so a
   * requirement stated only in prose is otherwise invisible to the one seat that writes the code. Absent,
   * blank, stripped to the spec block alone or to a restatement of `spec.problem`, or with either switch at
   * `"0"`, no section is rendered.
   */
  issueBody?: string;
  /**
   * The previous attempt's budget verdict plus the frozen files the driver re-ran red, when this round
   * retries a build its own ceiling stopped — no gate judged a killed builder, so this is not a gate's
   * complaint.
   */
  budgetStop?: string;
}

/** Build the kickoff prompt for the build child. */
export function buildPrompt(opts: BuildPromptOpts): string {
  const frozenList =
    opts.frozenPaths.length === 0
      ? "(none — this run froze no tests)"
      : opts.frozenPaths.map((p) => `- \`${p}\``).join("\n");
  // One section, two framings: a gate judged the last round and said this, or no gate judged it at all and
  // its own ceiling stopped it. A killed builder's work is committed, so the difference is "fix THAT" versus
  // "build ON it".
  const judged = opts.reentry?.trim() ?? "";
  const stopped = opts.budgetStop?.trim() ?? "";
  const reentry =
    stopped === "" && judged === ""
      ? ""
      : [
          "## Why this round exists",
          "",
          stopped === ""
            ? "An earlier round was checked and **failed**. Its gate said:"
            : "Your **previous attempt ran out of budget** — a ceiling stopped it, nothing judged its work. It is committed, so build ON it: read what is there before writing any of it again. The driver re-ran the frozen tests on that tree and these are **still failing**:",
          "",
          "```",
          stopped === "" ? judged : stopped,
          "```",
          "",
          stopped === ""
            ? "Fix THAT. Do not re-derive the feature from scratch and do not assume the previous attempt was right — the failure above is the thing you are answering."
            : "Finish THAT. Do not restart the feature from scratch.",
          "",
        ].join("\n");
  const added =
    opts.added === undefined || opts.added.trim() === ""
      ? ""
      : [
          "## New since your last round",
          "",
          `A challenge round ran between rounds and ${opts.added.trim()}. They are part of the contract now — make them pass too.`,
          "",
        ].join("\n");
  const runner =
    opts.testRunner === undefined || opts.testRunner.trim() === ""
      ? "No project test runner is configured, so run each frozen file with whatever command runs this repository's tests."
      : `The project runs one test file with \`${opts.testRunner}\` — the literal \`${TEST_RUNNER_PLACEHOLDER}\` is replaced by the file's path. Run the frozen files with that command as you work, and keep going until they pass.`;
  // The builder consults BOTH switches at its own call site, so `PI_ENSEMBLE_LEAN_BUILD_ISSUE_PROSE=0` takes
  // this seat's section out and leaves `specify`/`challenge` rendering.
  const issueSection = leanBuildIssueProseEnabled()
    ? leanIssueSection(opts.issueBody, LEAN_BUILD_ISSUE_LEAD, opts.spec.problem)
    : "";
  return [
    `You are implementing issue #${opts.issue}. The acceptance tests already exist and are committed; your job is to make them pass.`,
    "",
    "## The problem",
    "",
    opts.spec.problem,
    "",
    // Same seam as `specify-prompt` / `challenge-prompt`: the task statement before the criteria, and no line
    // at all when there is nothing to show.
    ...(issueSection === "" ? [] : [issueSection, ""]),
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
        "If the frozen tests cannot all pass together, call `report_blocked` naming each conflicting file and why, then stop. Do not edit a test to make it pass, and do not keep probing after you have reported it.",
        "",
        "## The runner",
        "",
        runner,
        "",
        "## What you write",
        "",
        "The implementation. Source files, fixtures and new tests you need for your own work are fine.",
        "",
        BUILD_SCOPE_CONTRACT,
        "",
        "**Do not touch `.pi/`, `.github/`, `.gitmodules` or `CODEOWNERS`** — those decide what the run's verification means, and the parent reverts them. **Do not commit**: leave your changes in the working tree, staged or not, and the parent makes the commit.",
        "",
        "## What you report",
        "",
        "Reply with what you implemented and how you convinced yourself the frozen tests pass.",
      ].join("\n"),
    "",
    reentry,
    added,
  ].join("\n");
}
