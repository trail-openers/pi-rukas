/**
 * work-driver-handoff-recovery.md — the GitHub-body twin of
 * `recoveryCommandsChat` in work-driver-handoff-recovery.chat.ts (the
 * in-chat renderer). PURE PRESENTER over the shared decision in
 * work-driver-handoff-recovery.ts (`recoveryStepsForCap`): it renders the
 * shared steps' literal command lines VERBATIM (this surface is the one
 * they were written for — cwd-relative paths, `tmp/issue-<N>/` scratch,
 * the body is posted from the repo root), emits the cap-specific PROSE,
 * and falls back to the branch-name-predicate branches when the shared
 * recipe is empty. The WHICH-cap-yields-WHICH-step decision lives in the
 * shared module — one place, so the two surfaces cannot drift apart.
 *
 * Split out of work-driver-handoff-markdown.ts (AGENTS.md §12
 * file-size limit).
 */

import { killDetail } from "./kill-detail.ts";
import { commitPrDirtyRootStep } from "./work-driver-handoff-commitpr.ts";
import { type RecoveryStep, recoveryStepsForCap } from "./work-driver-handoff-recovery.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import {
  type WorkState,
  filesPresentFromConsolidation,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";

const EMPTY_STEP: RecoveryStep = { section: "review-incomplete", comment: [], lines: [] };

export function recoveryCommandsMarkdown(state: WorkState): string[] {
  const ps = state.pipelineState;
  const issue = state.issue;
  const { cap, steps } = recoveryStepsForCap(state);
  const reason = (ps.normalisedSpec?.parkReason ?? "underspecified") as ParkReason;
  const lines: string[] = ["### Concrete recovery commands", "", "Pick one:", "", "```bash"];

  if (cap === "commit-pr-incomplete-consolidation") {
    // Interleaved with the surface's consolidated-verdict sections (the
    // files-present list, the commitPrRoot state block, the unmerged-paths
    // conflict hint) — the shared decision supplies the per-workstream
    // inspect/apply sequence these sections wrap.
    const missing = missingWorkstreamsFromConsolidation(ps.incompleteConsolidation);
    const filesPresent = filesPresentFromConsolidation(ps.incompleteConsolidation);
    const root = ps.commitPrRoot;
    const conflicted = (root?.unmergedPaths ?? []).length > 0;
    // #500 — a placeholder branch means `reset --hard HEAD` would abort a
    // merge in progress WITHOUT clearing the index; name the branch first.
    const clearRoot = root
      ? root.branch === "HEAD" || root.branch === "(detached or unknown)"
        ? "git rev-parse --abbrev-ref HEAD   # name the branch, then: git reset --hard <branch>"
        : `git reset --hard ${root.branch}`
      : "git reset --hard HEAD";
    const byNum = (n: string) => steps.find((s) => s.comment[0]?.startsWith(`${n}.`)) ?? EMPTY_STEP;
    const step1 = byNum("1");
    const step2 = byNum("2");
    const step3 = byNum("3");
    const step4 = byNum("4");
    if (filesPresent.length > 0) {
      const shown = filesPresent.slice(0, 10);
      lines.push(
        "### Committed (the present side of the consolidation verdict)",
        "",
        `- ${filesPresent.length} file(s) in the committed diff: ${shown.join(", ")}${filesPresent.length > 10 ? ` … and ${filesPresent.length - 10} more` : ""}`,
        "",
      );
    }
    lines.push(
      ...commitPrDirtyRootStep(root, "", ""),
      "# 1. Inspect each missing workstream's worktree — the developer's work is still there uncommitted:",
      ...step1.lines,
      "",
      ...(conflicted
        ? [
            "# 1b. repoRoot has unmerged paths — resolve or abort them first,",
            "#     otherwise `git apply` in step 2 will refuse to run:",
            "git status",
            "# resolve the conflicts by hand, then:",
            "git add <resolved-path>",
            "# (or discard the hand consolidation entirely — DESTRUCTIVE,",
            "#  the uncommitted staged work is lost):",
            clearRoot,
            "",
          ]
        : []),
      ...step2.comment.map((c) => `# ${c}`),
      ...step2.lines,
      "",
      ...step3.comment.map((c) => `# ${c}`),
      ...step3.lines,
      "",
      ...step4.comment.map((c) => `# ${c}`),
      ...step4.lines,
    );
    lines.push("```", "");
    return lines;
  }

  if (cap === "awaiting-human-merge") {
    const hold = ps.mergeHold;
    const pr = ps.prNumber;
    lines.push(
      `# PR #${pr ?? "?"} is open and complete — only the merge is held.`,
      hold?.authorityGranted
        ? `# Merging is permitted (${hold.authoritySource}); the evidence gate refused: ${hold.evidenceReason ?? "no evidence"}.`
        : "# Nothing grants this driver authority to merge here. Merging is opt-in by default.",
    );
  } else if (cap === "existing-pr-detected") {
    const pr = ps.existingPr;
    lines.push(
      `# Existing PR #${pr?.number ?? "?"} on ${pr?.headRefName ?? "<branch>"} (matched by ${pr?.matchedBy ?? "?"}).`,
      "# No branch was created and no subagent ran.",
    );
  } else if (cap === "intent-park") {
    // #398 — fires in `explore`, before the branch step: nothing was written,
    // no branch exists, nothing timed out. `parkAction` already has the text.
    lines.push(
      "# No branch, no worktree, no PR — the cycle halted at intent resolution.",
      "# There is nothing to inspect, push or abandon.",
    );
  } else if (cap === "review-incomplete") {
    // #543 F5 — the review could not be completed: a loop/token-budget cap
    // killed one of the six lenses, or a lens failed every retry. The
    // completed lenses' verdicts are already rendered above; the recovery
    // is to re-run the review, not to push the branch or take over a PR.
    lines.push(
      "# The six-pass review is INCOMPLETE — at least one lens could not finish.",
      "# The completed lenses' verdicts are above; the checkpoint block names",
      "# the driver-authored status file for the killed lens.",
    );
  }

  if (steps.length > 0) {
    for (const step of steps) {
      const comment = step.comment.map((c) =>
        c === "1. Do this: <park-action>" ? `1. Do this: ${parkAction(reason, issue)}` : c,
      );
      lines.push("", ...comment.map((c) => `# ${c}`), ...step.lines);
    }
    lines.push("```", "");
    return lines;
  }

  if (!ps.branchName) {
    // See the twin in work-driver-handoff-message.ts: the predicate is the
    // state, not the cap, so a NEW pre-branch cap cannot fall through to
    // commands for a branch that was never created.
    lines.push(
      ...killDetail(state).map((l) => `# ${l}`),
      "# 1. Read what the failing step actually reported:",
      `cat .pi/work-state/${issue}.json`,
      "",
      "# 2. Then re-run:",
      `/work ${issue} --restart`,
    );
  } else {
    lines.push(
      ...killDetail(state).map((l) => `# ${l}`),
      "# 1. Inspect what survived before deciding:",
      "git status",
      "git diff --stat",
      "",
      "# 2. Discard the cycle and start over (worktree changes are kept):",
      `rm .pi/work-state/${issue}.json`,
      "",
      "# 3. Take over manually — commit + push what's there, open the PR yourself:",
      "git add -p",
      "git commit",
      `git push -u origin ${ps.branchName}`,
    );
  }
  lines.push("```", "");
  return lines;
}
