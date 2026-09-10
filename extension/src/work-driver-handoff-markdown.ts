/**
 * work-driver-handoff-markdown — the GitHub cap-hit handoff comment body.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * formatter — no I/O, no Pi calls — so it's testable from a smoke test
 * with a synthetic state file. Posted by runHandoff (work-driver.ts) via
 * `gh pr comment` / `gh issue comment`.
 */

import type { ForgeType } from "./forge-detect.ts";
import { killDetail } from "./kill-detail.ts";
import { renderLensFindings } from "./lens-findings-render.ts";
import { capedPartialStateLines } from "./work-driver-caped-state.ts";
import { formatCycleTotal } from "./work-driver-cycle-total.ts";
import { explainCap } from "./work-driver-explain.ts";
import {
  adversarialOutcomeSection,
  adversarialRoundsLine,
} from "./work-driver-handoff-adversarial.ts";
import {
  commitPrDirtyRootStep,
  commitPrFallbackPlumbSection,
  commitPrRootFacts,
} from "./work-driver-handoff-commitpr.ts";
import { recoveryCommandsMarkdown } from "./work-driver-handoff-recovery.md.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * Build the cap-hit handoff markdown body.
 * Walks state.eventLog for: which cap fired (cap-hit event's `cap` field),
 * how many lens-review rounds ran, last lens-issues-found findings (for
 * the recurring-pattern paragraph), any plumb-reports, transcript paths
 * the user can grep through.
 *
 * Pure function — no I/O, no Pi calls — so it's testable from a smoke
 * with a synthetic state file.
 */
export function renderHandoffMarkdown(state: WorkState, forge?: ForgeType): string {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const capDescription = capHit
    ? (capHit as Extract<WorkEvent, { kind: "cap-hit" }>).cap
    : "review-round (3 of 3)";
  const lastFindings = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "lens-issues-found" }> => e.kind === "lens-issues-found",
    );
  const reviewRound = ps.reviewRound;
  const branch = ps.branchName ?? "(branch not captured)";
  // Pull transcript paths from the most recent dispatch-completed events
  // (last 5) so the user can drill into specific subagent runs.
  const transcripts = [...state.eventLog]
    .reverse()
    .filter(
      (e): e is Extract<WorkEvent, { kind: "dispatch-completed" }> =>
        e.kind === "dispatch-completed" && Boolean(e.transcriptPath),
    )
    .slice(0, 5)
    .map((e) => `- \`${e.label}\` — \`${e.transcriptPath}\``);
  const stepDurations = state.eventLog
    .filter(
      (e): e is Extract<WorkEvent, { kind: "dispatch-completed" }> =>
        e.kind === "dispatch-completed",
    )
    .map((e) => `- ${e.step.padEnd(14)} ${(e.ms / 1000).toFixed(1)}s · ${e.label}`);
  const branches = state.eventLog
    .filter(
      (e): e is Extract<WorkEvent, { kind: "branch-completed" }> => e.kind === "branch-completed",
    )
    .map((e) => `- ${e.workstreamId}: ${e.ok ? "ok" : "FAIL"}`);

  // PR5: explainCap provides the operator-readable WHY sentence used
  // across all three handoff surfaces (in-chat, GitHub body, /work-status).
  // No "adversarial-loop" default: naming a gate that passed is worse than
  // naming none. `explainCap` handles an absent cap explicitly now.
  const capForExplain = capHit?.kind === "cap-hit" ? capHit.cap : undefined;
  const explain = explainCap(capForExplain, state);

  // PR10 — multi-issue header + per-issue verdict block.
  const allIssues = state.issues ?? [issue];
  const issuesHeader = allIssues.length === 1 ? `\`#${issue}\`` : `\`#${allIssues.join("`, `#")}\``;
  const lines: string[] = [
    "## ⏸ Cap hit — needs human attention",
    "",
    `**Cap**: ${capDescription}`,
    // #534 — cycle cost so far, same shared helper as the terminal
    // scrollback line and /work-status so all three surfaces agree.
    // Omitted (not rendered as "0") when no event carries usage.
    ...(formatCycleTotal(state.eventLog)
      ? [`**Tokens**: ${formatCycleTotal(state.eventLog).trim()}`]
      : []),
    adversarialRoundsLine(state, capForExplain, reviewRound),
    `**Branch**: \`${branch}\``,
    `**Issues**: ${issuesHeader}`,
    `**State file**: \`.pi/work-state/${issue}.json\``,
    "",
    "### What this cap means",
    "",
    explain,
    "",
    ...commitPrRootFacts(state, capForExplain),
    ...commitPrFallbackPlumbSection(state, capForExplain),
    ...adversarialOutcomeSection(state),
    ...plumbReportSection(state),
    "### What was attempted",
    ...stepDurations.map((s) => s),
    "",
  ];
  if (allIssues.length > 1) {
    const active = ps.activeIssues ?? allIssues;
    const dropped = ps.droppedIssues ?? [];
    lines.push("### Issues in this cycle", "");
    for (const n of allIssues) {
      if (active.includes(n)) {
        lines.push(`- **#${n}** — NEEDS_WORK (active in this PR)`);
      } else {
        const d = dropped.find((x) => x.issue === n);
        lines.push(`- #${n} — ${d?.verdict ?? "UNKNOWN"}${d?.reason ? ` (${d.reason})` : ""}`);
      }
    }
    lines.push("");
  }

  // #543 F5 — the driver-owned checkpoint block for loop/token-budget cap
  // kills (shared with the chat renderer, same facts). Empty for every
  // other cap and for pre-#543 state files.
  lines.push(...capedPartialStateLines(state, "").map((l) => (l ? l : "")));

  // PR5: Worktree state at handoff (from handoffSnapshot).
  if (ps.handoffSnapshot) {
    const snap = ps.handoffSnapshot;
    lines.push(
      "### Worktree state at handoff",
      "",
      `- HEAD: \`${snap.headSha || "(unknown)"}\``,
      `- branch exists locally: ${snap.branchExists ? "yes" : "no"}`,
      `- branch pushed to origin: ${snap.branchPushed ? "yes" : "no (local only)"}`,
      `- uncommitted: ${snap.unstagedCount + snap.stagedCount} files (${snap.stagedCount} staged, ${snap.unstagedCount} unstaged)`,
    );
    if (snap.modifiedFiles.length > 0) {
      const shown = snap.modifiedFiles.slice(0, 10);
      lines.push(
        `- modified files (first ${shown.length} of ${snap.modifiedFiles.length}):`,
        ...shown.map((f) => `    - \`${f}\``),
      );
    }
    if (snap.retainedWorktrees?.length) {
      lines.push("- retained worktrees:", ...snap.retainedWorktrees.map((wt) => `    - \`${wt}\``));
      lines.push("");
    }
    // #674 — committed work on detached-HEAD worktrees: the porcelain-based
    // counts above report 0 for this shape (clean tree, commits ahead of
    // base). Name the work's true location (path + HEAD SHA + commits ahead)
    // so the operator can see where the work actually is without having to
    // discover it via `git worktree list`.
    if (snap.committedWork?.length) {
      lines.push(
        "- committed work on detached-HEAD worktrees (the porcelain counts above are blind to this):",
        ...snap.committedWork.map(
          (w) =>
            `    - \`${w.path}\` — HEAD \`${w.headSha.slice(0, 8)}\`, ${w.ahead} commit(s) ahead of base (workstream: ${w.worktreeId})`,
        ),
      );
      lines.push("");
    }
    lines.push("");
  }

  if (branches.length > 0) {
    lines.push("### Workstream verdicts (Step 4 fanout)", ...branches, "");
  }
  if (lastFindings) {
    // The findings themselves, not a pointer to them. This block used to say
    // "review the JSON findings in the state file" — so four nessie cycles
    // handed off with CRITICAL findings nobody read, and the same defects were
    // later rediscovered by hand from the diff. See lens-findings-render.ts.
    const rendered = renderLensFindings(lastFindings.findings, lastFindings.verdict);
    lines.push(
      ...(rendered.length > 0
        ? rendered
        : // A round that reported issues but stored no readable findings is
          // itself worth saying out loud — silence here would read as "the
          // review found nothing", which is the opposite of what happened.
          [
            `### Review findings — none recorded (verdict: ${lastFindings.verdict})`,
            "",
            "The round reported issues but the findings blob was empty or unreadable.",
            "",
          ]),
      "Patterns to look for:",
      "  - Same lens flagging the same shape across rounds → spec-level problem (MAST 41.77%)",
      "  - Orthogonal local bugs → genuine work remains, not a doctrine failure",
      "",
    );
  }

  // PR11 — when explore halted on empty issue bodies, list the failed
  // fetches above the recovery commands so the operator sees exactly
  // which `gh issue view N` calls broke (and can target the actual fix
  // — gh auth, gh version, network, or an extension hijack).
  if (capForExplain === "explore-bodies-empty" && (ps.emptyBodyIssues ?? []).length > 0) {
    lines.push(
      "### Empty / failed issue-body fetches",
      "",
      ...(ps.emptyBodyIssues ?? []).map((f) => `- **#${f.issue}** — ${f.reason}`),
      "",
    );
  }
  // PR12 — surface the step-back analysis (sddElement / diagnosis /
  // proposedRevision) above the recovery commands when the cap is
  // step-back-revise-spec. This is what the operator needs to actually
  // revise the issue — the recovery commands below just point at /plan.
  if (capForExplain === "step-back-revise-spec") {
    const sb = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
          e.kind === "step-back-completed",
      );
    if (sb) {
      lines.push(
        "### Step-back analysis (which SDD element is underspecified?)",
        "",
        `**SDD element**: ${sb.sddElement}`,
        "",
        `**Diagnosis**: ${sb.diagnosis}`,
        "",
        "**Proposed revision** (paste into the issue body or rephrase via /plan):",
        "",
        "```",
        sb.proposedRevision,
        "```",
        "",
      );
    }
  }

  // PR5: Concrete recovery commands (was prose "Suggested next steps").
  // The four named shell commands map to the four decisions an operator
  // faces at handoff time — same shape as renderHandoffUserMessage's
  // in-chat list, so the GitHub body and the chat agree on next actions.
  // PR6: explore-* caps halt before any branch/develop ran; surface
  // cap-shaped recovery commands rather than the wrong "git push what's
  // there" / "longer cap" set. The cap → commands mapping lives in
  // work-driver-handoff-recovery.md.ts (split for module-size hygiene).
  lines.push(...recoveryCommandsMarkdown(state, forge));

  if (transcripts.length > 0) {
    lines.push("### Transcripts (last 5)", ...transcripts, "");
  }

  // PR5: pointer footer.
  lines.push(
    "### Inspect further",
    "",
    `- Rich state + full event log: \`.pi/work-state/${issue}.json\``,
    `- Per-subagent transcripts (preserved on handoff): \`tmp/issue-${issue}/\``,
    `- This body file: \`tmp/issue-${issue}/handoff-comment.md\``,
  );

  return lines.join("\n");
}

/**
 * Plumbing failures the cycle worked around and kept going.
 *
 * `pipelineState.plumbReports` records git failures during lens-fix — a
 * failed commit or push — deliberately OUT of the event log, because
 * appending there would change the tail and `nextStep()` routes on it.
 * They matter precisely because the cycle continued: a lens-fix whose push
 * failed means the PR the reviewer is looking at does not contain the fix.
 */
function plumbReportSection(state: WorkState): string[] {
  const reports = state.pipelineState.plumbReports ?? [];
  if (reports.length === 0) return [];
  return [
    "### Plumbing that failed (the cycle continued anyway)",
    "",
    ...reports.map((r) => `- \`${r.step}\`: ${r.body}`),
    "",
  ];
}
