/**
 * work-driver-handoff-message — the in-chat handoff message.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * formatter, no I/O — produced by `runWorkDriver` (work-driver.ts) to
 * replace the PR4-and-earlier terse ~150-char pointer-to-JSON with a
 * full operator-facing summary via `pi.sendUserMessage`.
 */

import { renderLensFindings } from "./lens-findings-render.ts";
import { capedPartialStateLines } from "./work-driver-caped-state.ts";
import { commitPrRootFactLines } from "./work-driver-commit-inspect.ts";
import { MAX_REVIEW_ROUNDS } from "./work-driver-context.ts";
import { explainCap } from "./work-driver-explain.ts";
import { recoveryCommandsChat } from "./work-driver-handoff-recovery.chat.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * #500 — the in-chat twin of `commitPrRootFacts` in
 * work-driver-handoff-markdown.ts: what repoRoot actually holds when a
 * commit-pr handoff fires. The fact lines come from `commitPrRootFactLines`
 * (work-driver-commit-inspect.ts) — the shared single source — so the
 * in-chat message and the GitHub body agree on the facts (branch, unmerged
 * paths, staged count) and on the clearing command. Rendered only for the
 * `commit-pr-incomplete-consolidation` cap — that is the cap whose recovery
 * commands historically assumed a clean tree that did not exist.
 */
function commitPrRootLines(state: WorkState, repoRoot: string): string[] {
  const ps = state.pipelineState;
  const facts = commitPrRootFactLines(
    ps.commitPrRoot,
    ps.commitPrRootError,
    `git -C ${repoRoot} `,
    "  ",
  );
  if (facts.length === 0) return [];
  return ["repoRoot state at commit-pr handoff:", ...facts];
}

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
  // The review's own findings, in the surface the operator actually reads.
  // This message showed them NOWHERE — not a pointer, not a count — while the
  // six lenses had already located the defect, named the file and rated it
  // CRITICAL. Four nessie cycles handed off that way and the same defects were
  // rediscovered later by hand from the diff. See lens-findings-render.ts.
  const lastFindings = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "lens-issues-found" }> => e.kind === "lens-issues-found",
    );
  if (lastFindings) {
    const rendered = renderLensFindings(lastFindings.findings, lastFindings.verdict);
    if (rendered.length > 0) lines.push("", ...rendered);
  }

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
  // #543 F5 — the driver-owned checkpoint block for loop/token-budget cap
  // kills, mirroring the markdown renderer (shared renderer, same facts).
  // Empty for every other cap and for pre-#543 state files.
  lines.push(...capedPartialStateLines(state, "  ").map((l) => (l ? l : "")));
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
  // PR6 — explore-* caps halt before any branch/develop ran; the
  // "retry with longer cap" + "git push what's there" commands are
  // wrong (nothing was written; no work to push). Surface cap-shaped
  // recovery commands instead. The cap → commands mapping lives in
  // work-driver-handoff-recovery.chat.ts (split for module-size hygiene).
  lines.push(...recoveryCommandsChat(state, repoRoot, scratchDirAbs));
  return lines.join("\n");
}
