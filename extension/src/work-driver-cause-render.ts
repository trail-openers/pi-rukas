/**
 * work-driver-cause-render — #1675: the shared lead every handoff surface
 * prints before its recovery commands: the cause class, the one-sentence
 * reason, the evidence, and what the user can do. The issue comment and the
 * PR body (renderHandoffMarkdown), the in-chat message
 * (renderHandoffUserMessage) and the headless result (projectIssue) all read
 * the same verdict from work-driver-cause-class.ts.
 *
 * Also the scrub every rendered explanation passes through:
 *   - the "dependencies are still missing" hint is shown only when a
 *     dependency signature is on an extracted failing line (depsHintApplies,
 *     #1673). Failure texts written before that rule carry the hint inline,
 *     so it is removed here, not trusted;
 *   - the N=1 "cannot be attributed to a per-workstream defect" wording is
 *     replaced with the verify command's own failing line (#1675 criterion 5).
 */

import type { HeadlessCap } from "./headless/caps.ts";
import { failureOf } from "./headless/failure.ts";
import { failedStepOf } from "./headless/result.ts";
import { type CauseVerdict, causeVerdictOf } from "./work-driver-cause-class.ts";
import { depsHintApplies } from "./work-driver-verify-record.ts";
import type { WorkState } from "./workflow-state.ts";

/** The hint's opening phrases, one per `provisionDepsHint` branch. */
const DEPS_HINT_STARTS = [
  " — this looks like missing dependencies",
  " — provisioning ran via",
  " — the `.pi/worktree-setup` hook failed",
  " — provisioning symlinked",
  " — provisioning found no usable",
  " — the ops-dispatch branch-step fallback",
];

/**
 * Removes a dependency hint that the extracted failing lines do not support.
 * A hint runs from its opening phrase to the next `: ` (the separator before
 * the verify output) or the end of its line; the separator is kept.
 */
export function scrubDepsHint(text: string): string {
  if (!DEPS_HINT_STARTS.some((s) => text.includes(s))) return text;
  if (depsHintApplies(text)) return text;
  let out = text;
  for (const start of DEPS_HINT_STARTS) {
    for (let i = out.indexOf(start); i >= 0; i = out.indexOf(start)) {
      const colon = out.indexOf(": ", i);
      const newline = out.indexOf("\n", i);
      const ends = [colon, newline].filter((x) => x >= 0);
      const end = ends.length > 0 ? Math.min(...ends) : out.length;
      out = out.slice(0, i) + out.slice(end);
    }
  }
  return out;
}

/** The N=1 sentence the pre-#1675 classifier wrote, and what it now says. */
const STALE_N1 =
  "single-workstream cycle: the consolidated failure cannot be attributed to a per-workstream defect — park as needs-human with the specific assertion";
const N1_REPLACEMENT = "the verify command failed (the specific assertion is named above)";

/** Every explanation and evidence line passes through here before it is printed. */
export function causeSafeText(text: string): string {
  return scrubDepsHint(text).split(STALE_N1).join(N1_REPLACEMENT);
}

/** Longest run of consecutive backticks in `s`. */
function longestRun(s: string): number {
  let longest = 0;
  for (const run of s.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** Untrusted text as a code span whose fence is longer than any run inside it. */
function codeSpan(s: string): string {
  const fence = "`".repeat(longestRun(s) + 1);
  return `${fence} ${s} ${fence}`;
}

/** The "what you can do" sentence: a pi-rukas defect has no user action, and says so. */
function actionText(v: CauseVerdict): string {
  return v.userAction ?? "nothing — this is a pi-rukas defect, reported";
}

/** The markdown lead (issue comment and PR body): class, reason, evidence, action. */
export function causeLeadMarkdown(v: CauseVerdict): string[] {
  const head = v.causeClass
    ? `### Cause: **${v.causeClass}** — ${causeSafeText(v.causeReason)}`
    : `### Cause: none — ${causeSafeText(v.causeReason)}`;
  const evidence =
    v.causeEvidence.length > 0
      ? ["Evidence:", "", ...v.causeEvidence.map((e) => `- ${codeSpan(causeSafeText(e))}`), ""]
      : [];
  return [head, "", ...evidence, `**What you can do:** ${actionText(v)}`, ""];
}

/** The in-chat lead: the same four facts, one line each. */
export function causeLeadChat(v: CauseVerdict): string[] {
  const head = v.causeClass
    ? `Cause: ${v.causeClass} — ${causeSafeText(v.causeReason)}`
    : `Cause: none — ${causeSafeText(v.causeReason)}`;
  return [
    head,
    ...v.causeEvidence.map((e) => `  evidence: ${causeSafeText(e)}`),
    `  What you can do: ${actionText(v)}`,
  ];
}

/** The queue summary's one line: class, reason, then what to do. */
export function queueCauseAction(v: CauseVerdict): string {
  const head = v.causeClass ? `${v.causeClass}: ${v.causeReason}` : v.causeReason;
  return `${causeSafeText(head)}. ${actionText(v)}`;
}

/** The verdict a renderer prints for the cycle's cap, failure read as the headless result reads it. */
export function causeFor(state: WorkState, cap: HeadlessCap | undefined): CauseVerdict | undefined {
  const failure = failureOf(state, cap, failedStepOf(state));
  return causeVerdictOf(state, cap, failure);
}
