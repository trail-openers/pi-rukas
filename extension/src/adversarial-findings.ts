/**
 * adversarial-findings — the non-blocking findings a passed gate left behind.
 *
 * Only `CRITICAL_ISSUES_FOUND` blocks the commit. `ISSUES_FOUND` and
 * `MINOR_OBSERVATIONS` are documented in `agents-base/adversarial-developer.md`
 * as non-blocking, so a cycle carrying them proceeds — but proceeding is not
 * the same as discarding, and that distinction is the entire reason the
 * relaxed terminal rule is safe rather than a rubber stamp.
 *
 * They travel to two places: the pull request body, where a human sees them,
 * and the six-lens review's context, where the gate that *does* apply the
 * project's configurable severity threshold can weigh them with far more
 * information than the adversarial reviewer had.
 */

import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * The findings carried by the most recent passed adversarial gate.
 *
 * Reads backwards: a cycle that looped through lens-fix runs adversarial more
 * than once, and only the latest pass describes the diff as it now stands.
 */
export function carriedAdversarialFindings(eventLog: readonly WorkEvent[]): string | undefined {
  for (let i = eventLog.length - 1; i >= 0; i--) {
    const e = eventLog[i];
    if (e?.kind !== "adversarial-approved") continue;
    const findings = e.findings?.trim();
    return findings || undefined;
  }
  return undefined;
}

/** Render for a PR body. Empty string when there is nothing to say. */
export function renderCarriedFindings(findings: string | undefined): string {
  if (!findings?.trim()) return "";
  return [
    "## Adversarial review — non-blocking findings",
    "",
    "The adversarial gate passed this diff but left these unresolved. They did not",
    "block the commit (only `CRITICAL_ISSUES_FOUND` does); they are recorded here so",
    "they are decided deliberately rather than forgotten.",
    "",
    findings.trim(),
  ].join("\n");
}
