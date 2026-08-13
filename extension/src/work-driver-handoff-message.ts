/**
 * work-driver-handoff-message — the in-chat handoff message.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * formatter, no I/O — produced by `runWorkDriver` (work-driver.ts) to
 * replace the PR4-and-earlier terse ~150-char pointer-to-JSON with a
 * full operator-facing summary via `pi.sendUserMessage`.
 */

import { MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";
import { explainCap } from "./work-driver-explain.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * PR5 — operator-facing in-chat handoff message. Multi-line; produced
 * by `runWorkDriver` to replace the PR4-and-earlier terse ~150-char
 * pointer-to-JSON. Sections:
 *
 *   1. Banner (HANDOFF DISPATCH INCOMPLETE when GitHub posting failed)
 *   2. Why (explainCap)
 *   3. Worktree state (from handoffSnapshot)
 *   4. GitHub handoff (comment URL + label status)
 *   5. Artefacts (body file, state file, scratch dir)
 *   6. Recovery commands — four concrete shell snippets keyed to
 *      common decisions (retry with longer cap, inspect, abandon,
 *      take over manually)
 *
 * Pure function for testability; no I/O. The caller already has the
 * latest state, repoRoot, and scratchDir to pass.
 */
export function renderHandoffUserMessage(
  state: WorkState,
  repoRoot: string,
  scratchDirAbs: string,
): string {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const handoffEvt = [...state.eventLog].reverse().find((e) => e.kind === "handoff-emitted");
  // No "adversarial-loop" default: naming a gate that passed is worse than
  // naming none. `explainCap` handles an absent cap explicitly now.
  const cap = capHit?.kind === "cap-hit" ? capHit.cap : undefined;
  const why = explainCap(cap, state);
  const snap = ps.handoffSnapshot;
  const commentUrl = handoffEvt?.kind === "handoff-emitted" ? handoffEvt.commentUrl : undefined;
  const labelApplied = handoffEvt?.kind === "handoff-emitted" ? handoffEvt.labelApplied : false;
  const handoffBodyPath =
    (handoffEvt?.kind === "handoff-emitted" ? handoffEvt.handoffBodyPath : undefined) ??
    `${scratchDirAbs}/handoff-comment.md`;
  const branchName = ps.branchName ?? "(branch not captured)";
  // #398 — the display fallback must never reach a shell command. It did:
  // `git push -u origin (branch not captured)` shipped to an operator as a
  // copy-pasteable line. The markdown renderer already made this split.
  const branchForCmd = ps.branchName ?? "<branch>";
  const branchPushedTag = snap
    ? // #398 — `branchPushed: false` because no branch was ever CREATED used to
      // render "(NOT pushed — local only)", which asserts a local branch
      // exists. `branchExists` is the field that distinguishes them.
      !snap.branchExists
      ? " (no branch was created)"
      : snap.branchPushed
        ? " (pushed)"
        : " (NOT pushed — local only)"
    : "";
  const headTag = snap?.headSha ? ` · HEAD ${snap.headSha}` : "";
  const fileCount = snap ? snap.unstagedCount + snap.stagedCount : 0;
  const prTag = ps.prNumber ? `PR #${ps.prNumber}` : "no PR created";
  const target = ps.prNumber ? `pr ${ps.prNumber}` : `issue ${issue}`;

  const lines: string[] = [];

  // 1. Banner when GitHub posting failed.
  if (!commentUrl || !labelApplied) {
    lines.push(
      `⚠ pi-ensemble /work for issue #${issue} — HANDOFF DISPATCH INCOMPLETE`,
      "",
      "The handoff body was generated but the GitHub-side post FAILED:",
      `  - comment posted: ${commentUrl ? `[ok] ${commentUrl}` : "[FAILED] NOT posted"}`,
      `  - label applied:  ${labelApplied ? "[ok]" : "[FAILED] NOT applied"}`,
      "",
      "Post manually now:",
      `  gh ${ps.prNumber ? "pr" : "issue"} comment ${ps.prNumber ?? issue} --body-file ${handoffBodyPath}`,
      `  gh ${ps.prNumber ? "pr" : "issue"} edit ${ps.prNumber ?? issue} --add-label needs-human-attention`,
      "",
      "---",
      "",
    );
  }

  // PR10 — multi-issue: surface all requested + active + dropped issues.
  // For single-issue cycles the header collapses to the original
  // `issue #N` shape; multi-issue cycles get a richer header + extra
  // section listing the per-issue verdicts and reasons.
  const allIssues = state.issues ?? [issue];
  const headerIssues =
    allIssues.length === 1 ? `issue #${issue}` : `issues #${allIssues.join(", #")}`;
  // 2. Standard handoff sections.
  lines.push(
    `pi-ensemble /work for ${headerIssues} — HANDOFF (needs human attention)`,
    "",
    `Why: ${why}`,
    `Last step: ${ps.lastCompletedStep ?? ps.currentStep}${ps.reviewRound > 0 ? ` · review round ${ps.reviewRound}/${MAX_REVIEW_ROUNDS}` : ""}`,
    `Cycle: ${ps.status}${ps.status === "aborted" ? " (mid-flight failure, not a cap-hit)" : ""}`,
    "",
    "Worktree state:",
    // #398 — when no branch exists, say that, rather than printing a
    // parenthetical placeholder next to "(NOT pushed — local only)", which
    // together read as "there is a local branch you have not pushed".
    ps.branchName
      ? `  branch: ${ps.branchName}${branchPushedTag}${headTag}`
      : `  no branch was created${headTag}`,
    `  ${prTag}`,
    `  ${fileCount} file(s) modified${snap && snap.stagedCount > 0 ? ` (${snap.stagedCount} staged, ${snap.unstagedCount} unstaged)` : ""}`,
  );
  // PR10 — per-issue verdict surface for multi-issue cycles. Shows
  // active (NEEDS_WORK) + dropped (ALREADY_COMPLETE / NEEDS_CLARIFICATION)
  // with the per-issue reason explore provided.
  if (allIssues.length > 1) {
    const active = ps.activeIssues ?? allIssues;
    const dropped = ps.droppedIssues ?? [];
    lines.push("", "Issues in this cycle:");
    for (const n of allIssues) {
      if (active.includes(n)) {
        lines.push(`  #${n}: NEEDS_WORK (active in this PR)`);
      } else {
        const d = dropped.find((x) => x.issue === n);
        lines.push(`  #${n}: ${d?.verdict ?? "UNKNOWN"}${d?.reason ? ` — ${d.reason}` : ""}`);
      }
    }
  }
  if (snap && snap.modifiedFiles.length > 0) {
    const shown = snap.modifiedFiles.slice(0, 5);
    lines.push(
      `  modified: ${shown.join(", ")}${snap.modifiedFiles.length > 5 ? ` ... and ${snap.modifiedFiles.length - 5} more` : ""}`,
    );
  }
  // PR7 — surface per-workstream verdicts when the cycle hit a
  // multi-workstream halt (PR3 fanout). renderHandoffMarkdown already
  // emits this section for GitHub; mirror to chat so the operator
  // doesn't have to click into the PR body to see which branch failed.
  const lastConverged = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged",
    );
  if (lastConverged && lastConverged.verdicts.length > 0) {
    const okN = lastConverged.verdicts.filter((v) => v.ok).length;
    lines.push(
      "",
      `Workstream verdicts (${lastConverged.step} fanout, ${okN}/${lastConverged.verdicts.length} ok):`,
      ...lastConverged.verdicts.map((v) => `  ${v.id}: ${v.ok ? "ok" : "FAIL"}`),
    );
  }
  if (commentUrl) {
    lines.push(
      "",
      `GitHub handoff: ${commentUrl}`,
      `  label ${labelApplied ? "applied to" : "NOT applied to"} ${target}`,
    );
  }
  lines.push(
    "",
    "Artefacts:",
    `  rich body:   ${handoffBodyPath}`,
    `  state + log: ${repoRoot}/.pi/work-state/${issue}.json`,
    `  scratch:     ${scratchDirAbs}/  (preserved on handoff for inspection)`,
    "",
    "What to do next — pick one:",
  );
  // PR6 — explore-* caps halt before any branch/develop ran; the
  // "retry with longer cap" + "git push what's there" commands are
  // wrong (nothing was written; no work to push). Surface cap-shaped
  // recovery commands instead.
  if (cap === "explore-already-complete") {
    lines.push(
      "",
      "  # 1. Verify by reading the issue + the explore report:",
      `     gh issue view ${issue}`,
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. If you agree the issue is done, close it:",
      `     gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`,
      "",
      "  # 3. If you disagree, add context and re-run /work:",
      `     gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
      "",
      "  # 4. Abandon the handoff entry (no code was written; safe to discard):",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "awaiting-human-merge") {
    const hold = ps.mergeHold;
    const pr = ps.prNumber;
    lines.push(
      "",
      `PR #${pr ?? "?"} is open and the work is complete — only the merge is held.`,
      hold?.authorityGranted
        ? `Merging is permitted here (${hold.authoritySource}), but the evidence gate refused: ${hold.evidenceReason ?? "no evidence"}.`
        : "Nothing grants this driver authority to merge in this project. That is the default: merging is opt-in.",
      "",
      "  # 1. See what the checks actually say:",
      `     gh pr checks ${pr ?? "<pr>"}`,
      "",
      "  # 2. Review and merge it yourself:",
      `     gh pr view ${pr ?? "<pr>"} --web`,
      ...(hold?.authorityGranted
        ? []
        : [
            "",
            "  # 3. Or grant the driver authority — either add an explicit line to AGENTS.md",
            '  #    (e.g. "LLMs are allowed to squash merge PRs"), or pass --merge:',
            `     /work ${issue} --merge`,
          ]),
    );
  } else if (cap === "existing-pr-detected") {
    const pr = ps.existingPr;
    const head = pr?.headRefName ?? "<branch>";
    lines.push(
      "",
      `Existing PR #${pr?.number ?? "?"} on \`${head}\` (matched by ${pr?.matchedBy ?? "?"}).`,
      "No branch was created and no subagent ran.",
      "",
      "  # 1. Look at what the open PR already contains:",
      `     gh pr view ${pr?.number ?? "<pr>"} --json state,mergeable,files`,
      "",
      "  # 2. Continue that PR instead of starting over (preferred):",
      `     git -C ${repoRoot} fetch origin`,
      `     git -C ${repoRoot} checkout ${head}`,
      "",
      "  # 3. Or abandon it, then re-run — the pre-flight will pass once it is closed:",
      `     gh pr close ${pr?.number ?? "<pr>"} --comment "Superseded; restarting via /work"`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
      "",
      "  # 4. Or proceed anyway, accepting a second PR for this issue:",
      "     PI_ENSEMBLE_PR_PREFLIGHT=0 pi",
    );
  } else if (cap === "explore-needs-clarification") {
    lines.push(
      "",
      "  # 1. Read what explore couldn't determine:",
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. Edit the issue body to add the missing acceptance criteria / scope:",
      `     gh issue edit ${issue}`,
      "",
      "  # 3. Re-run /work once the issue is clearer:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
      "",
      "  # 4. Abandon the handoff entry:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    const probeIssue = failed[0]?.issue ?? issue;
    lines.push(
      "",
      "Empty/error body fetches:",
      ...failed.map((f) => `  #${f.issue} — ${f.reason}`),
      "",
      "  # 1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
      "     gh auth status",
      "     gh --version",
      "",
      "  # 2. Probe a failing issue via REST (works when `gh issue view` is broken):",
      `     gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`,
      "",
      "  # 3. If gh issue view is hijacked, check for a misbehaving gh extension:",
      "     gh extension list",
      "",
      `  # 4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
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
      "",
      "  # 1. Read the proposed revision + handoff context:",
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. Revise the issue body via /plan (or gh issue edit):",
      `     /plan ${issue}    # or: gh issue edit ${issue}`,
      "",
      "  # 3. Restart /work from scratch against the revised spec:",
      `     /work ${issue} --restart`,
      "",
      "  # 4. Abandon this cycle entirely:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "commit-pr-incomplete-consolidation") {
    const missing = ps.incompleteConsolidation ?? [];
    lines.push(
      "",
      "Missing workstreams from the committed diff:",
      ...missing.map(
        (m) =>
          `  ${m.id} — paths not in diff: ${m.paths.slice(0, 3).join(", ")}${m.paths.length > 3 ? "..." : ""}`,
      ),
      "",
      "  # 1. Inspect each missing workstream's worktree:",
      ...missing.map(
        (m) => `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} status --porcelain`,
      ),
      "",
      "  # 2. Apply each missing diff to the integration branch:",
      ...missing.map(
        (m) =>
          `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} diff HEAD | git -C ${repoRoot} apply --index`,
      ),
      "",
      "  # 3. Verify, commit, push:",
      `     git -C ${repoRoot} diff --name-only --cached`,
      `     git -C ${repoRoot} commit -m '<concise>'`,
      `     git -C ${repoRoot} push`,
      "",
      "  # 4. Or: abandon + restart from scratch:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      `     /work ${issue} --restart`,
    );
  } else if (cap === "intent-park") {
    // #398 — this cap fires in `explore`, BEFORE the branch step: no branch,
    // no worktree, no PR, nothing written. It used to fall through to the
    // generic block below and tell the operator to retry a timeout that never
    // happened, keep worktree changes that do not exist, and push a branch
    // that was never created. `parkAction` already produces the right text.
    const reason = (ps.normalisedSpec?.parkReason ?? "underspecified") as ParkReason;
    lines.push(
      "",
      "No branch, no worktree and no PR — the cycle halted at intent resolution,",
      "before plan or branch ran. There is nothing to inspect, push or abandon.",
      "",
      `  # 1. Do this: ${parkAction(reason, issue)}`,
      "",
      "  # 2. Read the resolver's own reasoning before deciding:",
      `     cat ${repoRoot}/.pi/work-state/${issue}/spec.txt`,
      "",
      "  # 3. Then re-run — the state file is discarded automatically on --restart:",
      `     /work ${issue} --restart`,
    );
  } else {
    lines.push(
      "",
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
      `     git -C ${repoRoot} push -u origin ${branchForCmd}`,
    );
  }
  return lines.join("\n");
}
