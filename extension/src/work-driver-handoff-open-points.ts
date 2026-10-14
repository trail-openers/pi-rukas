/**
 * work-driver-handoff-open-points — the security open points of a parked spec,
 * as handoff lines.
 *
 * The open-point gate records each unresolved security-class CRITICAL point in
 * `securityOpenPoints` (already quoted and clipped). Both handoff surfaces, the
 * GitHub body and the in-chat message, render that list from here, so they show
 * the same points under the same heading. Empty when the spec has none.
 */

/** The one field the renderers read; the persisted spec type satisfies it. */
type OpenPointsSource = { securityOpenPoints?: string[] } | undefined;

/** The heading both handoff surfaces use for the list. */
export const SECURITY_OPEN_POINTS_HEADING = "Security open points (unresolved)";

/** Markdown lines (GitHub handoff body); empty when there are none. */
export function securityOpenPointsMarkdown(spec: OpenPointsSource): string[] {
  const points = spec?.securityOpenPoints ?? [];
  if (points.length === 0) return [];
  return [`### ${SECURITY_OPEN_POINTS_HEADING}`, "", ...points.map((p) => `- ${p}`), ""];
}

/** Plain-text lines (in-chat handoff message); empty when there are none. */
export function securityOpenPointsChat(spec: OpenPointsSource): string[] {
  const points = spec?.securityOpenPoints ?? [];
  if (points.length === 0) return [];
  return [`${SECURITY_OPEN_POINTS_HEADING}:`, ...points.map((p) => `  - ${p}`)];
}
