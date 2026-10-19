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
import { causeForCycle, causeLeadMarkdown, causeSafeText } from "./work-driver-cause-render.ts";
import { inlineCodeSafe } from "./work-driver-conflict-evidence.ts";
import { formatCycleTotal } from "./work-driver-cycle-total.ts";
import { draftPrHandoffLines } from "./work-driver-draft-pr-handoff.ts";
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
import { fanoutVerdictLines } from "./work-driver-handoff-fanout.ts";
import { openPointsMarkdown } from "./work-driver-handoff-open-points.ts";
import { recoveryCommandsMarkdown } from "./work-driver-handoff-recovery.md.ts";
import { unreadableSnapshotLines } from "./work-driver-handoff-snapshot.ts";
import { describeBranchState } from "./work-driver-handoff-view.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import { dispatchDurations } from "./work-status-dispatch-durations.ts";
import { fmtElapsed } from "./work-status-events.ts";
import {
  type WorkstreamCallsRefusedEvent,
  refusalRowMarkdown,
} from "./workflow-state-events-workstream.ts";
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
  // #799 — per-dispatch durations: the shared helper reads the event log and
  // returns one row per dispatch (completed OR failed). The handoff was
  // already rendering per-dispatch rows under "What was attempted"; this
  // refactor re-uses the shared source so the handoff and /work-status
  // surfaces cannot drift apart, and it adds failed rows (which were
  // previously invisible here) so a post-mortem reader sees the attempts
  // that did not land, not just the ones that did.
  // fmtElapsed (shared with the status renderers) so the handoff and
  // /work-status format the same duration identically at any scale — a
  // 460_000ms dispatch reads `7m40s` here, not `460.0s`.
  const dispatchRows = dispatchDurations(state.eventLog).map((r) => {
    const failed = r.failed ? " · (failed)" : "";
    return `- ${r.step.padEnd(14)} ${fmtElapsed(r.ms)} · ${r.label}${failed}`;
  });
  // #848 — workstream verdicts come from the shared source (last develop
  // branches-converged, fence-flipped; else branch-completed) — the same
  // function + presence rule as the chat renderer, so a fence flip shows
  // as "FAIL — <reason>" in both surfaces, never a stale "ok".
  const branches = fanoutVerdictLines(state).map((v) => `- ${v.text}`);

  // PR5: explainCap provides the operator-readable WHY sentence used
  // across all three handoff surfaces (in-chat, GitHub body, /work-status).
  // No "adversarial-loop" default: naming a gate that passed is worse than
  // naming none. `explainCap` handles an absent cap explicitly now.
  const capForExplain = capHit?.kind === "cap-hit" ? capHit.cap : undefined;
  const explain = explainCap(capForExplain, state);

  // PR10 — multi-issue header + per-issue verdict block.
  const allIssues = state.issues ?? [issue];
  const issuesHeader = allIssues.length === 1 ? `\`#${issue}\`` : `\`#${allIssues.join("`, `#")}\``;
  // #1675 "what happened" first: class, reason, evidence and action lead the body.
  const verdict = causeForCycle(state);
  const lines: string[] = [
    "## ⏸ Cap hit — needs human attention",
    "",
    ...(verdict ? causeLeadMarkdown(verdict) : []),
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
    // #1090 — an operator grant to write protected paths is worth seeing here.
    ...(state.protectedGrant?.length
      ? [
          `**Protected-path grant** (\`--allow-protected\`): \`${state.protectedGrant.join("`, `")}\``,
        ]
      : []),
    "",
    "### What this cap means",
    "",
    causeSafeText(explain),
    "",
    ...draftPrHandoffLines(ps, forge),
    ...commitPrRootFacts(state, capForExplain),
    ...commitPrFallbackPlumbSection(state, capForExplain),
    ...adversarialOutcomeSection(state),
    ...plumbReportSection(state),
    ...verifyAttributionSection(state),
    ...writeFenceSection(state),
    ...retryTreeSection(state),
    ...workstreamRefusalSection(state),
    ...consolidationNotesSection(state),
    "### What was attempted",
    ...dispatchRows,
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
    // A failed git read leaves the snapshot's zeros in place; they must not
    // be printed as findings (see `handoffSnapshot.unreadable`).
    const notRead = unreadableSnapshotLines(ps);
    const unread = notRead.length > 0 ? " — NOT READ, see below" : "";
    const view = describeBranchState(snap, (sha) => `\`${sha}\``);
    lines.push(
      "### Worktree state at handoff",
      "",
      ...(snap.repoRootHeadSha ? [`- repo-root HEAD: \`${snap.repoRootHeadSha}\``] : []),
      ...(view.tip ? [`- branch ${view.tip}`] : []),
      `- branch exists locally: ${snap.branchExists ? "yes" : `no${unread}`}`,
      `- branch pushed to origin: ${snap.branchPushed ? "yes" : "no (local only)"}`,
      `- ${view.files}${unread}`,
    );
    if (notRead.length > 0) lines.push("", "```text", ...notRead, "```", "");
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
        "- committed work on detached-HEAD worktrees (committed — not in the uncommitted count above):",
        ...snap.committedWork.map(
          (w) =>
            `    - \`${w.path}\` — HEAD \`${w.headSha.slice(0, 8)}\`, ${w.ahead} commit(s) ahead of base (workstream: ${w.worktreeId})`,
        ),
      );
      lines.push("");
    }
    lines.push("");
  }

  // Presence rule (shared with the chat renderer via the same array):
  // render iff the chosen source is non-empty.
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
  lines.push(...openPointsMarkdown(ps.normalisedSpec, state.issue));
  // #1675 "host-local" commands come after the cause, collapsed: they name
  // paths on the machine that ran the cycle, which a GitHub reader cannot use.
  const recovery = recoveryCommandsMarkdown(state, forge);
  if (recovery.length > 0) {
    lines.push(
      "<details>",
      "<summary>Host-local recovery commands (for the machine that ran the cycle)</summary>",
      "",
      ...recovery,
      "",
      "</details>",
      "",
    );
  }

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
 * How many consolidation bullets the handoff prints. A cycle whose git reads
 * all fail can accumulate one note per skipped check per commit-pr attempt;
 * the first twenty say what broke and the tail is a count, so the operator
 * sees the bound rather than scrolling past it. The state file keeps its own
 * bound, `MAX_PERSISTED_NOTES` in work-driver-commit-pr-events.ts — this one
 * is about the comment, not the record.
 */
const MAX_RENDERED_NOTES = 20;

/**
 * #1153 — consolidation checks that did not run. A skipped check is recorded
 * as a note (never a silent pass), and the operator must see it here.
 *
 * The note is UNTRUSTED data on its way to a forge comment: it is composed
 * from a git error's stderr, an operator-supplied branch name, or a path. It
 * is rendered in a code span whose fence is longer than the note's longest
 * backtick run, so a note containing `` ` `` or a fence cannot break out of
 * the span and have the remainder read as markdown by `gh pr comment`.
 *
 * The list is bounded by MAX_RENDERED_NOTES above.
 */
function consolidationNotesSection(state: WorkState): string[] {
  const notes = state.pipelineState.consolidationNotes ?? [];
  if (notes.length === 0) return [];
  const shown = notes.slice(0, MAX_RENDERED_NOTES).map(renderNoteBullet);
  const hidden = notes.length - shown.length;
  return [
    "### Consolidation checks that did not run",
    "",
    ...shown,
    // The ellipsis names the count so "and 3 more" is visibly a truncation of
    // a record that exists, not the whole of it.
    ...(hidden > 0 ? [`- \`…and ${hidden} more\``] : []),
    "",
  ];
}

/** Longest run of consecutive backticks in `s` (0 when it has none). */
function longestBacktickRun(s: string): number {
  let longest = 0;
  const runs = s.match(/`+/g);
  if (runs) {
    for (const run of runs) longest = Math.max(longest, run.length);
  }
  return longest;
}

/**
 * One consolidation note as a bullet: coerced to a string (a state file that
 * predates the validator can carry a number or a nested object), collapsed to
 * one line, bounded to 500 chars, and fenced in a code span with more
 * backticks than the note contains. Markdown code spans ignore leading and
 * trailing whitespace, so the padding spaces keep a note that begins or ends
 * with a backtick from merging with its own fence.
 *
 * `<` and `>` need no escaping: the note is the *content* of a code span, and
 * CommonMark parses span content as literal text — only the closing backtick
 * run ends it. That is the opposite of `inlineCodeSafe`
 * (`work-driver-conflict-evidence.ts`), which strips backticks outright
 * because its caller hard-codes a single-backtick span it cannot lengthen and
 * so must remove the delimiters rather than fence around them; here the fence
 * is computed per note, so nothing is deleted.
 */
export function renderNoteBullet(note: unknown): string {
  const text = String(note)
    .replace(/[\r\n]+/g, " ")
    .slice(0, 500);
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  return `- ${fence} ${text} ${fence}`;
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

/**
 * #1647 — the tests the selected verify carried without blocking: the cycle
 * passed the gate on them, so the handoff is where a reader learns they were
 * ever in question.
 */
function verifyAttributionSection(state: WorkState): string[] {
  const a = state.pipelineState.verifyAttribution;
  if (!a || (a.flaky.length === 0 && a.baselineRed.length === 0)) return [];
  return [
    "### Tests the verify gate carried without blocking (#1647)",
    "",
    ...a.flaky.map((n) => `- \`${inlineCodeSafe(n)}\` — flaky (failed once, passed on the rerun)`),
    ...a.baselineRed.map((n) => `- \`${inlineCodeSafe(n)}\` — red on the base commit too`),
    "",
  ];
}

/**
 * #1652 — `report_workstream` calls the planner made and Pi refused. The
 * cycle may still have proceeded on the accepted set, so the refusals are the
 * only record of what the planner got wrong.
 */
function workstreamRefusalSection(state: WorkState): string[] {
  const rows = state.eventLog.filter(
    (e): e is WorkstreamCallsRefusedEvent => e.kind === "workstream-calls-refused",
  );
  if (rows.length === 0) return [];
  return [
    "### Workstream calls the planner had refused",
    "",
    ...rows.flatMap((r) => r.refused.map((x) => refusalRowMarkdown(r.label, x, inlineCodeSafe))),
    "",
  ];
}

/**
 * #1655 — writes the write fence refused. A refusal is the child correcting
 * itself, so it never parks a cycle; it is shown because a developer that kept
 * reaching for the repo root is evidence about its instructions.
 */
function writeFenceSection(state: WorkState): string[] {
  const n = state.pipelineState.writeFenceRefusals ?? 0;
  const unreadable = state.pipelineState.writeFenceUnreadable ?? 0;
  if (n === 0 && unreadable === 0) return [];
  const logs = `logged as \`write-fence-*.jsonl\` in the cycle's scratch dir`;
  const lines =
    unreadable === 0
      ? `- ${n} write${n === 1 ? "" : "s"} outside a developer's worktree ${n === 1 ? "was" : "were"} refused at write time. The refusals are ${logs}.`
      : `- Count unknown (${unreadable} refusal source${unreadable === 1 ? "" : "s"} unreadable or unlogged); ${n} refusal${n === 1 ? "" : "s"} counted from the readable logs. The refusals are ${logs}.`;
  return ["### Writes refused by the write fence", "", lines, ""];
}

/**
 * #1391 — what the driver did with the trees lost attempts left behind. The
 * ref and the patch are the recovery handles for work a retry cleared away.
 */
function retryTreeSection(state: WorkState): string[] {
  const rows = state.eventLog.filter((e) => e.kind === "retry-tree-clean");
  if (rows.length === 0) return [];
  return [
    "### Work lost step attempts left behind",
    "",
    ...rows.map((r) => {
      const handles = [
        r.ref ? `ref \`${inlineCodeSafe(r.ref)}\`` : "",
        r.patch ? `patch \`${inlineCodeSafe(r.patch)}\`` : "",
      ].filter(Boolean);
      const why = r.detail ? ` — ${inlineCodeSafe(r.detail)}` : "";
      return `- \`${r.step}\` attempt ${r.attempt}: ${r.outcome}, ${r.fileCount} file(s)${handles.length ? ` · ${handles.join(" · ")}` : ""}${why}`;
    }),
    "",
  ];
}
