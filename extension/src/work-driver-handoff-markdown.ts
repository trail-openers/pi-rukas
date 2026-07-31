/**
 * work-driver-handoff-markdown — the GitHub cap-hit handoff comment body.
 *
 * Extracted from work-driver.ts (issue #171 file-size hygiene). Pure
 * formatter — no I/O, no Pi calls — so it's testable from a smoke test
 * with a synthetic state file. Posted by runHandoff (work-driver.ts) via
 * `gh pr comment` / `gh issue comment`.
 */

import { explainCap } from "./work-driver-explain.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

/**
 * Build the cap-hit handoff markdown body per /work.md Step 7g shape.
 * Walks state.eventLog for: which cap fired (cap-hit event's `cap` field),
 * how many lens-review rounds ran, last lens-issues-found findings (for
 * the recurring-pattern paragraph), any plumb-reports, transcript paths
 * the user can grep through.
 *
 * Pure function — no I/O, no Pi calls — so it's testable from a smoke
 * with a synthetic state file.
 */
export function renderHandoffMarkdown(state: WorkState): string {
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
  const capForExplain = capHit?.kind === "cap-hit" ? capHit.cap : ("adversarial-loop" as const);
  const explain = explainCap(capForExplain, state);

  // PR10 — multi-issue header + per-issue verdict block.
  const allIssues = state.issues ?? [issue];
  const issuesHeader = allIssues.length === 1 ? `\`#${issue}\`` : `\`#${allIssues.join("`, `#")}\``;
  const lines: string[] = [
    "## ⏸ Cap hit — needs human attention",
    "",
    `**Cap**: ${capDescription}`,
    `**Rounds**: ${reviewRound} of 3 review rounds`,
    `**Branch**: \`${branch}\``,
    `**Issues**: ${issuesHeader}`,
    `**State file**: \`.pi/work-state/${issue}.json\``,
    "",
    "### What this cap means",
    "",
    explain,
    "",
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
    lines.push("");
  }

  if (branches.length > 0) {
    lines.push("### Workstream verdicts (Step 4 fanout)", ...branches, "");
  }
  if (lastFindings) {
    const verdict = lastFindings.verdict;
    lines.push(
      `### Recurring finding pattern (last round: ${verdict})`,
      "",
      "Review the JSON findings in the state file's most recent `lens-issues-found` event.",
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
  // there" / "longer cap" set.
  const branchForCmd = ps.branchName ?? "<branch>";
  lines.push("### Concrete recovery commands", "", "Pick one:", "", "```bash");
  if (capForExplain === "explore-already-complete") {
    lines.push(
      "# 1. Verify by reading the issue + the explore report:",
      `gh issue view ${issue} && cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. If you agree the issue is done, close it:",
      `gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`,
      "",
      "# 3. If you disagree, add context and re-run /work:",
      `gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
      `rm .pi/work-state/${issue}.json && pi`,
      "",
      "# 4. Abandon the handoff entry (no code was written; safe to discard):",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (capForExplain === "explore-needs-clarification") {
    lines.push(
      "# 1. Read what explore couldn't determine:",
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. Edit the issue body to add the missing acceptance criteria / scope:",
      `gh issue edit ${issue}`,
      "",
      "# 3. Re-run /work once the issue is clearer:",
      `rm .pi/work-state/${issue}.json && pi`,
      "",
      "# 4. Abandon the handoff entry:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (capForExplain === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const probeIssue = failed[0]?.issue ?? issue;
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    lines.push(
      "# 1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
      "gh auth status && gh --version",
      "",
      "# 2. Probe a failing issue via REST (works when `gh issue view` is broken):",
      `gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`,
      "",
      "# 3. If gh issue view is hijacked, check for a misbehaving gh extension:",
      "gh extension list",
      "",
      `# 4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
      `rm .pi/work-state/${issue}.json && pi`,
    );
  } else if (capForExplain === "step-back-revise-spec") {
    lines.push(
      "# 1. Read the proposed revision above and the rich handoff body:",
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. Revise the issue body via /plan (or gh issue edit) — apply the proposed wording:",
      `/plan ${issue}    # or: gh issue edit ${issue}`,
      "",
      "# 3. Restart /work from scratch against the revised spec:",
      `/work ${issue} --restart`,
      "",
      "# 4. Abandon this cycle entirely:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (capForExplain === "commit-pr-incomplete-consolidation") {
    const missing = ps.incompleteConsolidation ?? [];
    lines.push(
      "# 1. Inspect each missing workstream's worktree — the developer's work is still there uncommitted:",
      ...missing.map((m) => `git -C .worktrees/issue-${issue}-${m.id} status --porcelain`),
      "",
      "# 2. Apply the missing diffs to the integration branch:",
      ...missing.map(
        (m) =>
          `git -C .worktrees/issue-${issue}-${m.id} diff HEAD | git apply --index    # in the integration tree`,
      ),
      "",
      "# 3. Verify all workstreams' files now appear, then commit + push:",
      "git diff --name-only --cached",
      "git commit -m '<concise>' && git push",
      "",
      "# 4. Or: abandon + restart from scratch:",
      `rm .pi/work-state/${issue}.json && /work ${issue} --restart`,
    );
  } else {
    lines.push(
      "# 1. Inspect what survived before deciding:",
      "git status && git diff --stat",
      "",
      "# 2. Retry with a longer per-spawn cap (use if dispatches kept timing out):",
      `export PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000 && rm .pi/work-state/${issue}.json && pi`,
      "",
      "# 3. Abandon the cycle, keep the worktree changes for manual takeover:",
      `rm .pi/work-state/${issue}.json`,
      "",
      "# 4. Take over manually — commit + push what's there, open the PR yourself:",
      `git add -p && git commit && git push -u origin ${branchForCmd}`,
    );
  }
  lines.push("```", "");

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
