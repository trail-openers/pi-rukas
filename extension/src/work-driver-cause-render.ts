/**
 * work-driver-cause-render — #1675: the shared lead every handoff surface
 * prints before its recovery commands: the cause class, the one-sentence
 * reason, the evidence, and what the user can do. The issue comment and the
 * PR body (renderHandoffMarkdown), the in-chat message (renderHandoffUserMessage),
 * the headless result (projectIssue) and the queue line all read the verdict
 * from causeForCycle (work-driver-cause-for.ts), which scrubs it at the source.
 *
 * The renderers still call causeSafeText (work-driver-cause-scrub.ts), which is
 * idempotent, as the fallback for a state file written before the producer scrubbed.
 */

import type { CauseVerdict } from "./work-driver-cause-class.ts";
import { causeSafeText, escapeMarkdownText } from "./work-driver-cause-scrub.ts";

/** Untrusted text as a code span whose fence is longer than any run inside it. */
function codeSpan(s: string): string {
  const longest = Math.max(0, ...(s.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${s} ${fence}`;
}

/** The "what you can do" sentence: a pi-rukas defect has no user action, and says so. */
function actionText(v: CauseVerdict): string {
  return v.userAction ?? "nothing — this is a pi-rukas defect, reported";
}

/** The markdown lead (issue comment and PR body): class, reason, evidence, action. */
export function causeLeadMarkdown(v: CauseVerdict): string[] {
  const reason = escapeMarkdownText(causeSafeText(v.causeReason));
  const head = v.causeClass
    ? `### Cause: **${v.causeClass}** — ${reason}`
    : `### Cause: none — ${reason}`;
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
