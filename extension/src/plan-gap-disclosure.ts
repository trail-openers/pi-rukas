/**
 * plan-gap-disclosure — the operator-visible renderings of gap-gate findings:
 * the residual-findings section of a filed body and the settled-gaps list in a
 * gate prompt (#1043, D2). Split out of plan-gaps.ts (500-line hard limit,
 * AGENTS.md §12); plan-gaps.ts re-exports these names.
 */
import type { PlanGap } from "./plan-types.ts";

/**
 * The display bound for operator-visible residual findings.
 *
 * Applied ONLY at the render sites (the filed body's residual section via
 * `residualGapsSection`, and the inline cap-message list in plan-tool.ts via
 * `renderResidualList`). parseGaps keeps the FULL description on the object
 * so the union dedupe (seenDescriptions) keys on the complete string — two
 * genuinely different findings that share a 300-char prefix used to collide
 * on the truncated form and the second was silently dropped from the
 * disclosure (lens review, PR #637 finding 1 — a disclosure-completeness
 * bug in the terminal rule's precondition, since under CRITICAL-only blocking
 * the disclosure IS what allows filing).
 */
const RESIDUAL_DISPLAY_MAX = 300;

/** The single truncation applied to residual findings for display. */
export function truncateForDisclosure(s: string): string {
  return s.length > RESIDUAL_DISPLAY_MAX ? `${s.slice(0, RESIDUAL_DISPLAY_MAX - 1)}…` : s;
}

/**
 * The residual-findings disclosure appended to the spec when the cap routes
 * to filing (D2). Naming each gap with its severity + proposed resolution is
 * what makes the disclosure a disclosure — an unposted residual would be the
 * silent swallow the /work doctrine refuses.
 */
export function residualGapsSection(residual: PlanGap[]): string {
  const items = residual
    .map((g) => `- [${g.severity}] ${truncateForDisclosure(g.description)} → ${g.resolution}`)
    .join("\n");
  return `## Residual gap-gate findings\n\n${items}\n`;
}

/**
 * #1132: the open points of a spec filed at the gate's iteration cap: the
 * still-blocking gaps (CRITICAL with no proposed resolution), so the unresolved
 * points are visible on the issue rather than blocking its filing.
 */
export function openPointsSection(points: PlanGap[]): string {
  if (points.length === 0) return "";
  const items = points
    .map((g) => `- [${g.severity}] ${truncateForDisclosure(g.description)}`)
    .join("\n");
  return `## Open points (unresolved at the gap-gate cap)\n\nThe gap gate reached its iteration cap with these points still blocking and no proposed resolution. The issue is filed so they are visible; the /work intent gate decides whether it is buildable.\n\n${items}\n`;
}

/**
 * Ceiling on the settled-gaps list rendered into a gate prompt (#1043 review).
 */
const SETTLED_SECTION_MAX = 10;

/**
 * #1043 — the prior dry run's gaps, appended to the FIRST gate prompt on a
 * cache miss. They are framed as settled so the reviewer does not re-raise
 * them; a finding the spec now contradicts is still raised. Empty when there
 * is no prior run (the prompt is then byte-identical to before).
 */
export function settledGapsSection(settled: PlanGap[]): string {
  if (settled.length === 0) return "";
  // Bounded like the residual disclosure: the 10 most severe, each side clipped.
  const rank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const items = [...settled]
    .sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4))
    .slice(0, SETTLED_SECTION_MAX)
    .map(
      (g) =>
        `- [${g.severity}] ${truncateForDisclosure(g.description)} → ${truncateForDisclosure(g.resolution)}`,
    )
    .join("\n");
  return `\n\nALREADY SETTLED — a prior gap-gate run on this same descriptor raised the findings below. Do NOT re-raise them unless the spec now contradicts them; a finding the spec already addresses is settled.\n${items}`;
}
