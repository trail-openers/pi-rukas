import { scratchHygieneSection } from "./work-driver-prompts-late.ts";

/**
 * Step 3 (branch) prompt builder — the inline prompt the driver sends to
 * ops when the mechanized branch setup path is not taken.
 */
export function inlineBranchPrompt(
  issues: number[],
  workstreamIds: string[],
  scratchDirAbs: string,
  /**
   * #844 — the driver-fetched base SHA. When present the prompt names this
   * EXACT SHA instead of "the fresh mainline tip" so ops builds the branch
   * from the same commit the driver then verifies against (the merge-base
   * check in runBranchViaOpsDispatch). The ops-fallback path fires after a
   * failed fetch, so the call site may omit it — the prompt then keeps the
   * pre-#844 "fresh mainline tip" shape.
   */
  baseSha?: string,
): string {
  const multi = workstreamIds.length > 1;
  const multiIssue = issues.length > 1;
  const primary = issues[0] ?? 0;
  const headline = multiIssue ? `issues #${issues.join(", #")}` : `issue #${primary}`;
  const branchHint = multiIssue
    ? `feature/issues-${issues.join("-")}-<brief-description>`
    : `feature/issue-${primary}-<brief-description>`;
  const worktreePrefix = multiIssue
    ? `.worktrees/issues-${issues.join("-")}`
    : `.worktrees/issue-${primary}`;
  const lines = [
    `/work ${headline} — Step 3 (Setup). Create the feature branch under the safety preconditions below.`,
    "",
    "  1. Identify the mainline branch (default `main`; detect via `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`).",
    "  2. Verify clean working tree (`git status --porcelain` must be empty). If dirty, ABORT and surface the failure verbatim — do NOT branch off uncommitted work.",
    "  3. Fetch + fast-forward mainline (`git fetch origin && git checkout <mainline> && git pull --ff-only origin <mainline>`). If --ff-only fails, ABORT.",
    ...(baseSha
      ? [
          `  4. Create branch \`${branchHint}\` from the driver-fetched base SHA \`${baseSha}\`. Verify with \`git rev-parse \`${branchHint}\`\` that the branch sits exactly at that SHA — the driver verifies this after your reply and HALTS the cycle with a cap on any mismatch.`,
          `     If a local branch of the target name already exists, do NOT build on its tip: it may be stale. Use \`git branch -f \`${branchHint}\` \`${baseSha}\`\` to create it at the base SHA, or report the conflict verbatim.`,
        ]
      : [`  4. Create branch \`${branchHint}\` from the fresh mainline tip.`]),
    "  5. End your reply with a single line `branch: <branch-name>` so the driver can capture it.",
  ];
  if (multi) {
    lines.push(
      "",
      `  6. **Multi-workstream cycle** — Step 2 decomposed the active issue${multiIssue ? "s" : ""} into ${workstreamIds.length} workstreams (${workstreamIds.join(", ")}). Create one git worktree per workstream off the feature branch:`,
      "",
      ...workstreamIds.map(
        (id) =>
          `       git worktree add ${worktreePrefix}-${id} ${branchHint.replace("<brief-description>", "<brief>")}`,
      ),
      "",
      "  7. End your reply with an additional fenced `## Worktrees` block mapping each workstream id to its absolute path:",
      "",
      "       ```markdown",
      "       ## Worktrees",
      "",
      ...workstreamIds.map((id) => `       - ${id}: <absolute-path-to-worktree>`),
      "       ```",
      "",
      "       Use `git rev-parse --show-toplevel` from inside each worktree to get the absolute path. The driver parses this block to wire up Step 4's per-workstream developer dispatches.",
    );
  } else {
    lines.push(
      "",
      "Single-workstream cycle — do NOT create worktrees. The driver records the repo root as the `default` workstream's path automatically.",
    );
  }
  lines.push(scratchHygieneSection(scratchDirAbs));
  return lines.join("\n");
}
