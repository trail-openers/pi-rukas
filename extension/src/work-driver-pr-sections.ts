/**
 * work-driver-pr-sections — PR-body sections shared across body builders.
 *
 * #456 — the PR body is composed in two places: the mechanized commit-pr
 * builder (work-driver-commit.ts) and, per #455, the ops fallback prompt
 * (work-driver-prompts-late.ts). Any section that must appear in BOTH is
 * defined here once so the two writers cannot drift. Whichever of #455 and
 * #456 lands first defines the shared section; the other imports it.
 *
 * The six-pass lens review is the most thorough review in the pipeline and
 * was the one nobody saw: `computeVerdict` retains `summary.findings` at
 * every severity, but no code path read them into the PR body — not on
 * APPROVED and not on ISSUES_FOUND. This renders them (with severity and
 * whether they blocked) so the human reads the review, not a pointer to a
 * state file.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { renderLensFindings } from "./lens-findings-render.ts";
import { verifyAttributionSectionOf } from "./work-driver-verify-select-render.ts";
import type { VerifyAttributionRecord } from "./work-driver-verify-shared.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * #1647 — the seam's pre-existing-failures section, then the selected verify's
 * flaky and baseline-red sections. Both describe gate results the cycle pushed
 * past, so they sit in one place in the PR body.
 */
export function carried(
  section: string,
  ps: { verifyAttribution?: VerifyAttributionRecord },
): string {
  return section + verifyAttributionSectionOf(ps.verifyAttribution);
}

/**
 * #1652 — the planner's refused `report_workstream` calls, for the PR body. A
 * refused call contributed nothing to the plan, and the plan went ahead on the
 * calls it kept: a reviewer must be able to see what was dropped without
 * opening the state file. Empty when no call was refused, so a clean plan's
 * PR body is unchanged.
 */
export function planRefusalsSection(eventLog: readonly WorkEvent[]): string {
  const events = eventLog.filter(
    (e): e is Extract<WorkEvent, { kind: "workstream-calls-refused" }> =>
      e.kind === "workstream-calls-refused",
  );
  if (events.length === 0) return "";
  const lines = events.flatMap((e) =>
    e.refused.map(
      (r) =>
        `- \`${neutraliseMarkdownField(r.id ?? "(no id)")}\` (${e.label}): ${neutraliseMarkdownField(r.reason)}`,
    ),
  );
  const omitted = events.reduce((n, e) => n + (e.omitted ?? 0), 0);
  if (omitted > 0) lines.push(`- ${omitted} more refused call(s) not listed`);
  return [
    "## Planner refused some workstream calls",
    "",
    "The plan went ahead on the workstream calls it accepted. These `report_workstream` calls were refused and contributed nothing to it:",
    "",
    ...lines,
  ].join("\n");
}

/**
 * Render the lens-findings section for a PR body.
 *
 * Reads the event log backwards for the most recent lens verdict — a cycle
 * that looped through lens-fix re-runs lens-review, and only the latest
 * verdict describes the diff as it now stands. An APPROVED pass carries
 * sub-threshold findings (did not block); an ISSUES_FOUND/CRITICAL pass
 * carries findings at or above the project threshold (blocked until the
 * lens-fix loop cleared them). Empty string when nothing is recorded, so a
 * clean cycle's PR body is unchanged.
 */
export function renderLensFindingsSection(eventLog: readonly WorkEvent[]): string {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (e?.kind === "lens-issues-found") {
      return buildSection(e.findings, e.verdict, true);
    }
    if (e?.kind === "lens-approved" && e.findings?.trim()) {
      return buildSection(e.findings, "APPROVED", false);
    }
  }
  return "";
}

/** The PR-body sections derived from the event log, in body order (lens findings, then refusals). */
export function eventLogSections(eventLog: readonly WorkEvent[]): string[] {
  return [renderLensFindingsSection(eventLog), planRefusalsSection(eventLog)];
}

function buildSection(blob: string, verdict: string, blocked: boolean): string {
  const findings = renderLensFindings(blob, verdict);
  if (findings.length === 0) return "";
  return [
    "## Lens review — findings",
    "",
    blocked
      ? "The six-pass review found issues at or above the project's blocking threshold. They have been cleared through the lens-fix loop; they are recorded here for the record."
      : "The six-pass review passed (APPROVED). These sub-threshold findings did not block the commit; recording them is what keeps a silent pass from reading as a rubber stamp.",
    "",
    ...findings,
  ].join("\n");
}
