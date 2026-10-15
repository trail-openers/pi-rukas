/**
 * work-driver-handoff-open-points — the blocking Open points lines of a parked spec,
 * as handoff lines (#1187).
 *
 * The open-point gate records each blocking line of the filed issue's Open points
 * section in `openPoints` (flattenIssueText output, unclipped). Both handoff surfaces,
 * the GitHub body and the in-chat message, render that list from here, so they show
 * the same points under the same heading, each in a code span that the issue text
 * cannot break out of, followed by the way out. Empty when the spec has none.
 */

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

/** Markdown lines (GitHub handoff body); empty when there are none. */
export function openPointsMarkdown(spec: OpenPointsSource, issue: number): string[] {
  const points = spec?.openPoints ?? [];
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
  const points = spec?.openPoints ?? [];
  if (points.length === 0) return [];
  return [
    `${OPEN_POINTS_HANDOFF_HEADING}:`,
    `  answer each point, mark it [RESOLVED] right after its tag, then run /work ${issue} --restart`,
    ...points.map((p) => `  - ${codeSpan(p)}`),
  ];
}
