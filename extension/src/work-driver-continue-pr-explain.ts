/**
 * work-driver-continue-pr-explain — #1468: the WHY and the human action for
 * the six caps `--continue-pr` can raise. Pure formatters.
 *
 * None of the actions says a bare `--restart`: a restart without
 * `--continue-pr` meets the same open PR and stops on `existing-pr-detected`.
 */

import type { WorkCapLiteral } from "./workflow-state-events-caps.ts";

export type ContinuePrCap = Extract<WorkCapLiteral, `continue-pr-${string}`>;

const CONTINUE_CAPS: readonly ContinuePrCap[] = [
  "continue-pr-ambiguous",
  "continue-pr-fork",
  "continue-pr-head-moved",
  "continue-pr-not-found",
  "continue-pr-unresolved",
  "continue-pr-unsafe-head",
];

export function isContinueCap(cap: string): cap is ContinuePrCap {
  return (CONTINUE_CAPS as readonly string[]).includes(cap);
}

const BEFORE_BRANCH =
  "The driver stopped before the branch step, so nothing was written and no branch was touched.";

/** The operator-readable sentence for a continue-pr cap. */
export function explainContinueCap(cap: ContinuePrCap, evidence: string | undefined): string {
  const ev = evidence ?? "no detail recorded";
  switch (cap) {
    case "continue-pr-ambiguous":
      return `\`--continue-pr\` found more than one open PR for this issue (${ev}). The driver will not pick one. ${BEFORE_BRANCH}`;
    case "continue-pr-fork":
      return `\`--continue-pr\` found the issue's PR, but its head is from a fork (${ev}). The driver cannot push to a fork's branch. ${BEFORE_BRANCH}`;
    case "continue-pr-not-found":
      return `\`--continue-pr\` could not find exactly one open PR for this issue (${ev}). ${BEFORE_BRANCH}`;
    case "continue-pr-unsafe-head":
      return `the PR's head branch is not safe to continue (${ev}). The driver checks the branch name, the PR's base and the local copy of the branch before it touches anything. ${BEFORE_BRANCH}`;
    case "continue-pr-head-moved":
      return `the PR's head branch moved while the cycle ran (${ev}). Someone else pushed to it, deleted it or rewound it. The driver never force-pushes, so it stopped rather than overwrite or build on commits it did not check.`;
    case "continue-pr-unresolved":
      return `the merge of the mainline into the PR's head is not finished (${ev}). A conflict, a leftover conflict marker, or a history the driver did not expect remains in the worktree, so nothing was pushed. The worktree is kept as it is.`;
  }
}

/** What a human should do about a continue-pr cap. */
export function continueHumanAction(cap: ContinuePrCap, primary: number): string {
  switch (cap) {
    case "continue-pr-ambiguous":
      return `close all but one of the open PRs for #${primary}, then re-run with \`--continue-pr\``;
    case "continue-pr-fork":
      return `continue #${primary}'s PR by hand: the driver cannot push to a fork`;
    case "continue-pr-not-found":
      return `check that #${primary}'s PR is open and that \`gh pr list\` works, then re-run with \`--continue-pr\``;
    case "continue-pr-unsafe-head":
      return `fix #${primary}'s PR head branch by hand (its name, its base, or the local copy), then re-run with \`--continue-pr\``;
    case "continue-pr-head-moved":
      return `wait for the other push to #${primary}'s PR to settle, then re-run with \`--continue-pr\``;
    case "continue-pr-unresolved":
      return `finish the merge in #${primary}'s kept worktree, or re-run \`/work ${primary} --restart --continue-pr\``;
  }
}
