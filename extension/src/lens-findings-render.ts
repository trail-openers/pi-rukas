/**
 * lens-findings-render — put the review's findings in front of the operator.
 *
 * The six-pass review produces structured findings — lens, severity, path,
 * line, title, description — and stores them on the `lens-issues-found` event.
 * Every handoff surface then threw them away: the GitHub body printed *"Review
 * the JSON findings in the state file's most recent `lens-issues-found`
 * event"* plus generic advice about patterns to look for, the in-chat message
 * printed nothing at all, and `/work-status` printed a count.
 *
 * The cost of that was measured. Across four measured cycles the operator's PM
 * reported discovering, by reading the committed diff by hand, exactly the
 * defects the lenses had already found and reported hours earlier:
 *
 *   - a SECURITY CRITICAL on `src/config/mod.rs` — the entire config module
 *     root deleted — rediscovered as "the deleted config module";
 *   - a SIMPLICITY HIGH on `src/session/mod.rs:85` — two independent
 *     `persist_lock` mutexes — rediscovered as "the duplicate locks";
 *   - an ERROR_HANDLING CRITICAL on `src/cron/mod.rs:594` — every SIG file
 *     reprocessed each tick — refiled as a brand-new issue.
 *
 * The conclusion drawn from that was "review approval proved a weak signal".
 * The reviews were not weak. Nobody was ever shown them.
 *
 * Rendering is deliberately dense and severity-ordered: the first line a human
 * reads should be the worst thing the review found, not a pointer to a file
 * path they will not open.
 *
 * The blob is agent-authored content that survived a JSON round trip, and these
 * lines are posted to the forge (PR body, handoff comment, round-cap residual
 * post), so every free-text field goes through `neutraliseMarkdownField` — a
 * stored title carrying `<!-- … -->` or a markdown link cannot survive into the
 * post, and the residual disclosure's own merge-guard marker is matched by
 * substring search, so a second one on the PR is not cosmetic.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";

/** Worst first. Anything unrecognised sorts last but is still shown. */
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

/** How many findings to print in full before summarising the tail. */
const MAX_RENDERED = 12;

interface StoredFinding {
  lens?: string;
  severity?: string;
  path?: string;
  line?: number;
  title?: string;
}

/**
 * Parse the `findings` blob off a `lens-issues-found` event.
 *
 * Stored as a JSON string rather than structured data, so this is the one
 * place that has to cope with it being absent, truncated or malformed. A bad
 * blob yields an empty list rather than throwing — a renderer that crashes
 * would cost the operator the whole handoff, which is the failure this module
 * exists to prevent.
 */
export function parseFindings(blob: string | undefined): StoredFinding[] {
  if (!blob) return [];
  try {
    const parsed: unknown = JSON.parse(blob);
    return Array.isArray(parsed) ? (parsed as StoredFinding[]) : [];
  } catch {
    return [];
  }
}

function rank(severity: string | undefined): number {
  const i = SEVERITY_ORDER.indexOf(
    (severity ?? "").toUpperCase() as (typeof SEVERITY_ORDER)[number],
  );
  return i === -1 ? SEVERITY_ORDER.length : i;
}

/** `SEVERITY  LENS  path:line — title` — every field neutralised, the shape kept. */
function renderOne(f: StoredFinding): string {
  const where = f.path
    ? neutraliseMarkdownField(
        `${f.path}${typeof f.line === "number" && f.line > 0 ? `:${f.line}` : ""}`,
      )
    : "(no path)";
  const sev = (f.severity ?? "UNKNOWN").toUpperCase();
  const lens = neutraliseMarkdownField(f.lens ?? "UNKNOWN");
  const title = neutraliseMarkdownField(f.title ?? "(no title)");
  return `- **${sev}** \`${lens}\` — \`${where}\` — ${title}`;
}

/**
 * Render the findings as markdown lines, worst first.
 *
 * Returns an empty array when there is nothing to show, so callers can splice
 * it into a line list without a conditional.
 */
export function renderLensFindings(blob: string | undefined, verdict?: string): string[] {
  const findings = parseFindings(blob);
  if (findings.length === 0) return [];
  const sorted = [...findings].sort((a, b) => rank(a.severity) - rank(b.severity));
  const shown = sorted.slice(0, MAX_RENDERED);
  const counts = new Map<string, number>();
  for (const f of sorted) {
    const sev = (f.severity ?? "UNKNOWN").toUpperCase();
    counts.set(sev, (counts.get(sev) ?? 0) + 1);
  }
  const tally = [...counts.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([sev, n]) => `${n} ${sev}`)
    .join(", ");

  const lines = [
    `### Review findings — ${tally}${verdict ? ` (verdict: ${verdict})` : ""}`,
    "",
    ...shown.map(renderOne),
  ];
  if (sorted.length > shown.length) {
    // Never silently truncate: an operator who cannot see that there are more
    // will read the list as complete.
    lines.push(
      "",
      `_…and ${sorted.length - shown.length} more. The full set is on the last \`lens-issues-found\` event in the state file._`,
    );
  }
  lines.push("");
  return lines;
}
