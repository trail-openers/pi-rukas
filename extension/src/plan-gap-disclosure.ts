/**
 * plan-gap-disclosure — the operator-visible renderings of gap-gate findings:
 * the residual-findings section of a filed body and the settled-gaps list in a
 * gate prompt (#1043, D2). Split out of plan-gaps.ts (500-line hard limit,
 * AGENTS.md §12). Importers take these names from this module; plan-gaps.ts
 * does not re-export them.
 */
import { OPEN_POINTS_HEADING, OPEN_POINTS_INTRO } from "./open-points-contract.ts";
import { duplicateExclusionSection } from "./plan-duplicate-disclosure.ts";
import { GAP_RESOLUTION_PLACEHOLDER } from "./plan-gap-parse.ts";
import { planImageLinksSection } from "./plan-images.ts";
import type { DuplicateRisk } from "./plan-investigate.ts";
import { withProvenance } from "./plan-provenance.ts";
import type { PlanDriverInput, PlanGap } from "./plan-types.ts";
import type { IssueImage } from "./work-driver-issue-images.ts";

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
 * #1132: the open points of a spec filed at the gate's iteration cap: every
 * CRITICAL still unresolved at the cap, each with the gate's proposal when it
 * gave one, so the unresolved points are visible on the issue rather than
 * blocking its filing.
 *
 * #1187 fix round 1: the intro sentence is the contract constant
 * `OPEN_POINTS_INTRO`, not a literal. It is non-bullet prose under the heading, and the
 * intent gate parks on any prose line it does not read as an item, so an inline literal
 * meant a gap-gate-filed issue could never be cleared by `[RESOLVED]`: the points all
 * resolved, the intro still parked. The writer and the reader take the same constant.
 */
export function openPointsSection(points: PlanGap[]): string {
  if (points.length === 0) return "";
  const items = points
    .map((g) => {
      const proposal =
        g.resolution === GAP_RESOLUTION_PLACEHOLDER
          ? "no proposed resolution"
          : `proposed: ${truncateForDisclosure(g.resolution)}`;
      return `- [${g.severity}] ${truncateForDisclosure(g.description)} — ${proposal}`;
    })
    .join("\n");
  return `## ${OPEN_POINTS_HEADING}\n\n${OPEN_POINTS_INTRO}\n\n${items}\n`;
}

/**
 * #1132: the disclosure for a spec drafted from the local checkout because the
 * origin base could not be read. "" when the run had a base.
 */
export function baseFallbackSection(reason: string | undefined): string {
  if (!reason) return "";
  return `## Base fallback\n\nThis spec was drafted from the local checkout, not origin/<default>: ${reason}. The investigators read the checkout, so the spec may reflect uncommitted or unpushed local changes.\n`;
}

/**
 * The body that gets filed or shown on a dry run: the spec, then each
 * disclosure section that applies (#1132: open points and the base fallback).
 *
 * #1856: `duplicateExclusion` is the pre-rendered duplicate-candidate disclosure
 * the driver builds in plan-duplicate-self.ts. It is passed in already rendered
 * (rather than derived here) because the verdict it describes lives on the
 * investigation barrier, not on the gap data this module owns — and it is
 * appended at THIS fixed site so no prior-context budget can clip it.
 */
export function filedBodyOf(
  body: string,
  residual: PlanGap[],
  openPoints: PlanGap[],
  baseFallback: string | undefined,
  duplicateExclusion = "",
): string {
  return [
    body,
    residual.length > 0 ? residualGapsSection(residual) : "",
    openPointsSection(openPoints),
    baseFallbackSection(baseFallback),
    duplicateExclusion,
  ]
    .filter(Boolean)
    .join("\n\n");
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

/**
 * The body the pipeline files or shows: every disclosure section that applies,
 * then the image links, then the caller's provenance wrapped around the whole.
 *
 * #1856 — one home so the duplicate-candidate disclosure cannot be appended at
 * one call site and forgotten at another: `filedBodyOf` receives it already
 * rendered (it describes the investigation barrier's verdict, not gap data), and
 * this is the only site that renders it. The pre-#1856 driver built these same
 * three calls inline; moving them here is the size-cap seam (AGENTS.md §12),
 * with the ordering preserved exactly.
 */
export function finalDraftBody(
  body: string,
  residual: PlanGap[],
  openPoints: PlanGap[],
  baseFallback: string | undefined,
  images: IssueImage[],
  provenance: PlanDriverInput["provenance"],
  duplicate: { risk: DuplicateRisk | undefined; sourceIssue: number | undefined },
): string {
  return withProvenance(
    filedBodyOf(
      body,
      residual,
      openPoints,
      baseFallback,
      duplicateExclusionSection(duplicate.risk, duplicate.sourceIssue),
    ) + planImageLinksSection(images),
    provenance,
  );
}
