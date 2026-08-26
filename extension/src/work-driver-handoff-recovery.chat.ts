/**
 * work-driver-handoff-recovery.chat — the in-chat twin of
 * `recoveryCommandsMarkdown` in work-driver-handoff-recovery.md.ts
 * (the GitHub-body renderer). PURE PRESENTER over the shared decision in
 * work-driver-handoff-recovery.ts (`recoveryStepsForCap`): it re-qualifies
 * the shared literal lines to absolute paths (`git -C <repoRoot>`,
 * absolute scratch), emits the cap-specific PROSE, and falls back to the
 * branch-name-predicate branches when the shared recipe is empty. The
 * WHICH-cap-yields-WHICH-step decision lives in the shared module — one
 * place, so the two surfaces cannot drift apart.
 *
 * Split out of work-driver-handoff-message.ts (AGENTS.md §12
 * file-size limit).
 */

import { killDetail } from "./kill-detail.ts";
import { commitPrDirtyRootStep } from "./work-driver-handoff-commitpr.ts";
import {
  type RecoveryStep,
  recoveryStepsForCap,
  requalifyLine,
} from "./work-driver-handoff-recovery.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import {
  type WorkEvent,
  type WorkState,
  filesPresentFromConsolidation,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";

/** Resolve a step's shared lines to this surface's concrete lines. */
function resolveLines(
  step: RecoveryStep,
  ctx: { repoRoot: string; scratchDirAbs: string; handoffBodyPath: string },
): string[] {
  return step.lines.map((line) => {
    if (line === `cat ${ctx.handoffBodyPath}`) return line;
    return requalifyLine(line, ctx.repoRoot, ctx.scratchDirAbs);
  });
}

/** Render a step's comment + commands in this surface's indentation. */
function renderStep(
  step: RecoveryStep,
  refCtx: { repoRoot: string; scratchDirAbs: string; handoffBodyPath: string },
  reason: ParkReason,
  issue: number,
): string[] {
  const comment = step.comment.map((c) =>
    c === "1. Do this: <park-action>" ? `1. Do this: ${parkAction(reason, issue)}` : c,
  );
  return [...comment.map((c) => `  # ${c}`), ...resolveLines(step, refCtx).map((l) => `     ${l}`)];
}

export function recoveryCommandsChat(
  state: WorkState,
  repoRoot: string,
  scratchDirAbs: string,
): string[] {
  const ps = state.pipelineState;
  const issue = state.issue;
  const { cap, steps } = recoveryStepsForCap(state);
  const handoffBodyPath =
    (
      state.eventLog
        .slice()
        .reverse()
        .find((e) => e.kind === "handoff-emitted") as { handoffBodyPath?: string } | undefined
    )?.handoffBodyPath ?? `${scratchDirAbs}/handoff-comment.md`;
  const refCtx = { repoRoot, scratchDirAbs, handoffBodyPath };
  const reason = (ps.normalisedSpec?.parkReason ?? "underspecified") as ParkReason;
  const lines: string[] = ["", "What to do next — pick one:"];

  // Cap-specific PROSE the surface renders before its steps.
  if (cap === "awaiting-human-merge") {
    const hold = ps.mergeHold;
    const pr = ps.prNumber;
    lines.push(
      "",
      `PR #${pr ?? "?"} is open and the work is complete — only the merge is held.`,
      hold?.authorityGranted
        ? `Merging is permitted here (${hold.authoritySource}), but the evidence gate refused: ${hold.evidenceReason ?? "no evidence"}.`
        : "Nothing grants this driver authority to merge in this project. That is the default: merging is opt-in.",
    );
  } else if (cap === "existing-pr-detected") {
    const pr = ps.existingPr;
    lines.push(
      "",
      `Existing PR #${pr?.number ?? "?"} on \`${pr?.headRefName ?? "<branch>"}\` (matched by ${pr?.matchedBy ?? "?"}).`,
      "No branch was created and no subagent ran.",
    );
  } else if (cap === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    lines.push(
      "",
      "Empty/error body fetches:",
      ...failed.map((f) => `  #${f.issue} — ${f.reason}`),
    );
  } else if (cap === "step-back-revise-spec") {
    const sb = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
          e.kind === "step-back-completed",
      );
    lines.push(
      "",
      "Step-back analysis:",
      `  SDD element underspecified: ${sb?.sddElement ?? "(not parsed)"}`,
      `  Diagnosis: ${sb?.diagnosis ?? "(not parsed)"}`,
      "",
      "Proposed revision (preview — full text in the GitHub handoff body):",
      `  ${(sb?.proposedRevision ?? "(not parsed)").slice(0, 160)}${(sb?.proposedRevision?.length ?? 0) > 160 ? "..." : ""}`,
    );
  } else if (cap === "review-incomplete") {
    lines.push(
      "",
      "The six-pass review is INCOMPLETE — at least one lens could not finish,",
      "so the diff was not fully reviewed. The completed lenses' verdicts are",
      "shown above; the cap-hit checkpoint block says what was saved on the",
      "killed lens's side.",
    );
  } else if (cap === "intent-park") {
    // #398 — this cap fires in `explore`, BEFORE the branch step: no branch,
    // no worktree, no PR, nothing written. `parkAction` already has the text.
    lines.push(
      "",
      "No branch, no worktree and no PR — the cycle halted at intent resolution,",
      "before plan or branch ran. There is nothing to inspect, push or abandon.",
    );
  }

  if (cap === "commit-pr-incomplete-consolidation") {
    // Interleaved with the surface's consolidated-verdict sections (the
    // files-present list, the commitPrRoot state block, the unmerged-paths
    // conflict hint) — the shared decision supplies the per-workstream
    // inspect/apply sequence these sections wrap.
    const missing = missingWorkstreamsFromConsolidation(ps.incompleteConsolidation);
    const filesPresent = filesPresentFromConsolidation(ps.incompleteConsolidation);
    const root = ps.commitPrRoot;
    const conflicted = (root?.unmergedPaths ?? []).length > 0;
    // #500 — a placeholder branch (`HEAD`) in the recorded state means the
    // inspection couldn't name the branch; `reset --hard HEAD` aborts a merge
    // in progress WITHOUT clearing the index. Name the branch first.
    const clearRoot = root
      ? root.branch === "HEAD" || root.branch === "(detached or unknown)"
        ? `git -C ${repoRoot} rev-parse --abbrev-ref HEAD   # name the branch, then: git -C ${repoRoot} reset --hard <branch>`
        : `git -C ${repoRoot} reset --hard ${root.branch}`
      : `git -C ${repoRoot} reset --hard HEAD`;
    const step1 = steps.find(
      (s) => s.section === "commit-pr-incomplete-consolidation" && s.comment[0]?.startsWith("1."),
    );
    const step2 = steps.find(
      (s) => s.section === "commit-pr-incomplete-consolidation" && s.comment[0]?.startsWith("2."),
    );
    const step3 = steps.find(
      (s) => s.section === "commit-pr-incomplete-consolidation" && s.comment[0]?.startsWith("3."),
    );
    const step4 = steps.find(
      (s) => s.section === "commit-pr-incomplete-consolidation" && s.comment[0]?.startsWith("4."),
    );
    lines.push(
      "",
      ...(filesPresent.length > 0
        ? [
            `Committed (the present side of the consolidation verdict): ${filesPresent.length} file(s) — ${filesPresent.slice(0, 5).join(", ")}${filesPresent.length > 5 ? ` … and ${filesPresent.length - 5} more` : ""}`,
            "",
          ]
        : []),
      "Missing workstreams from the committed diff:",
      ...missing.map(
        (m) =>
          `  ${m.id} — paths not in diff: ${m.paths.slice(0, 3).join(", ")}${m.paths.length > 3 ? "..." : ""}`,
      ),
      "",
      ...commitPrDirtyRootStep(root, "  ", `     git -C ${repoRoot} `),
      "  # 1. Inspect each missing workstream's worktree:",
      ...resolveLines(
        step1 ?? { section: "commit-pr-incomplete-consolidation", comment: [], lines: [] },
        refCtx,
      ).map((l) => `     ${l}`),
      "",
      ...(conflicted
        ? [
            "  # 1b. repoRoot has unmerged paths — resolve or abort them first",
            "  #     or step 2's `git apply` will refuse to run:",
            `     git -C ${repoRoot} status`,
            "     # resolve the conflicts by hand, then: git add <resolved-path>",
            `     # (or discard the hand consolidation — DESTRUCTIVE): ${clearRoot}`,
            "",
          ]
        : []),
      ...(step2?.comment ?? []).map((c) => `  # ${c}`),
      ...resolveLines(
        step2 ?? { section: "commit-pr-incomplete-consolidation", comment: [], lines: [] },
        refCtx,
      ).map((l) => `     ${l}`),
      "",
      ...(step3?.comment ?? []).map((c) => `  # ${c}`),
      ...resolveLines(
        step3 ?? { section: "commit-pr-incomplete-consolidation", comment: [], lines: [] },
        refCtx,
      ).map((l) => `     ${l}`),
      "",
      ...(step4?.comment ?? []).map((c) => `  # ${c}`),
      ...resolveLines(
        step4 ?? { section: "commit-pr-incomplete-consolidation", comment: [], lines: [] },
        refCtx,
      ).map((l) => `     ${l}`),
    );
    return lines;
  }

  if (steps.length > 0) {
    for (const step of steps) {
      lines.push("", ...renderStep(step, refCtx, reason, issue));
    }
    return lines;
  }

  if (!ps.branchName) {
    // Nothing was created, so the generic block below is all wrong: it tells
    // the operator to inspect a worktree that does not exist and push a branch
    // that was never made. This used to be special-cased per cap, which meant
    // every NEW pre-branch cap (a timed-out explore, for one) fell through to
    // the misleading text again. The predicate is the state, not the cap.
    lines.push(
      "",
      "No branch, no worktree and no PR — the cycle halted before the branch step,",
      "so there is nothing to inspect, push or abandon.",
      "",
      ...killDetail(state).map((l) => `  ${l}`),
      "  # 1. Read what the failing step actually reported:",
      `     cat ${repoRoot}/.pi/work-state/${issue}.json`,
      "",
      "  # 2. Then re-run:",
      `     /work ${issue} --restart`,
    );
  } else {
    lines.push(
      "",
      ...killDetail(state).map((l) => `  ${l}`),
      "  # 1. Inspect what survived before deciding:",
      `     git -C ${repoRoot} status`,
      `     git -C ${repoRoot} diff --stat`,
      "",
      "  # 2. Discard the cycle and start over (worktree changes are kept):",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "",
      `  # 3. Take over manually — commit + push what's there, open the PR yourself:`,
      `     git -C ${repoRoot} add -p`,
      `     git -C ${repoRoot} commit`,
      `     git -C ${repoRoot} push -u origin ${ps.branchName}`,
    );
  }
  return lines;
}
