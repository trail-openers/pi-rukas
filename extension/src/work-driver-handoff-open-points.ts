/**
 * work-driver-handoff-open-points — the blocking Open points lines of a parked spec,
 * as handoff lines (#1187).
 *
 * The open-point gate records each blocking line of the filed issue's Open points
 * section in `openPoints` (flattenIssueText output; bounded and redacted when written —
 * see `blockingOpenPointTexts` in open-points-reader.ts). Both handoff surfaces,
 * the GitHub body and the in-chat message, render that list from here, so they show
 * the same points under the same heading, each in a code span that the issue text
 * cannot break out of, followed by the way out. Empty when the spec has none.
 *
 * The renderers redact again rather than trusting the stored field. `openPoints` reaches
 * them through a persisted artifact written by an older cycle, and a handoff comment is
 * the one surface here that is public: redaction is cheap, a leaked token is not.
 */

import { OPEN_POINT_CHAR_CAP } from "./open-points-reader.ts";
import { flattenIssueText, redactThenBound } from "./text-flatten.ts";

/** The one field the renderers read; the persisted spec type satisfies it. */
type OpenPointsSource = { openPoints?: string[] } | undefined;

/** The heading both handoff surfaces use for the list. */
export const OPEN_POINTS_HANDOFF_HEADING = "Open points (unresolved)";

/**
 * A code span whose backtick fence is longer than the longest backtick run in `text`,
 * so no run inside the text can close it.
 */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * The list the renderers show: every stored point, flattened, redacted and bounded at the
 * public boundary, with anything that sanitises away to nothing dropped (#1187 fix round 4).
 *
 * The flatten is part of this boundary, not a courtesy: `openPoints` is written bounded by
 * the gate and bounded by the artifact reader, but the renderers accept any value that
 * satisfies the field, and a stored newline there would forge a bullet or a `### heading`
 * inside the handoff body. `redactThenBound` then replaces credentials — the same
 * normaliser the writer uses, so the boundary and the store cannot drift — and the filter
 * drops a line the redactor reduced to whitespace so it never renders as an empty bullet.
 */
function renderablePoints(spec: OpenPointsSource): string[] {
  return (spec?.openPoints ?? [])
    .map((p) => flattenIssueText(redactThenBound(p, OPEN_POINT_CHAR_CAP).text))
    .filter((p) => p.trim() !== "");
}

/** Markdown lines (GitHub handoff body); empty when there are none. */
export function openPointsMarkdown(spec: OpenPointsSource, issue: number): string[] {
  const points = renderablePoints(spec);
  if (points.length === 0) return [];
  return [
    `### ${OPEN_POINTS_HANDOFF_HEADING}`,
    "",
    `Answer each point, mark it [RESOLVED] right after its severity tag on the first line (unemphasised), then run \`/work ${issue} --restart\`.`,
    "",
    ...points.map((p) => `- ${codeSpan(p)}`),
    "",
  ];
}

/** Plain-text lines (in-chat handoff message); empty when there are none. */
export function openPointsChat(spec: OpenPointsSource, issue: number): string[] {
  const points = renderablePoints(spec);
  if (points.length === 0) return [];
  return [
    `${OPEN_POINTS_HANDOFF_HEADING}:`,
    `  answer each point, mark it [RESOLVED] right after its tag, then run /work ${issue} --restart`,
    ...points.map((p) => `  - ${codeSpan(p)}`),
  ];
}
