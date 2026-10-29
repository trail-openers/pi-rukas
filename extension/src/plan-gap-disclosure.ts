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
import { PI_SPEC_OMISSION_PREFIX, placePiSpecSection } from "./plan-pi-spec.ts";
import { provenanceLineOf, withProvenance } from "./plan-provenance.ts";
import type { PlanDriverInput, PlanGap, PlanType } from "./plan-types.ts";
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
  // #1883: the ticket type, so the `pi-spec v1` block is placed at THIS one
  // site and knows not to write one for an epic or a spike. Absent = no block,
  // which keeps every pre-#1883 call site byte-identical.
  type?: PlanType,
  // #1883: the filed TITLE, which is the block's `problem` field. Optional, and
  // absent means no block — a call site that has not been updated cannot file a
  // spec whose problem field is a guess, and an epic, a spike or a criteria-less
  // draft files a body byte-identical to the pre-#1883 render.
  title?: string,
): string {
  // #1883: the block is placed HERE — after every drafted section, every
  // disclosure and the image links, and immediately before `withProvenance`
  // wraps the provenance marker — because this is the ONE home for the filed
  // body: the compaction fitter and every section renderer run long before it,
  // so nothing can trim the block once it is here. `codeAppendReservation`
  // (plan-driver-phase3.ts) is what paid for its width out of the body budget
  // BEFORE drafting ran, the same way it reserves the marker — that is the whole
  // of the budget story: the block is invisible to compaction because it is
  // written after compaction, and it is guaranteed to fit because its width was
  // subtracted from the budget first.
  //
  // It is placed at the TOP of that assembled body (above every drafted section,
  // so prose below cannot open a fence that swallows it), and read back before it
  // is trusted.
  const assembled =
    filedBodyOf(
      body,
      residual,
      openPoints,
      baseFallback,
      duplicateExclusionSection(duplicate.risk, duplicate.sourceIssue),
    ) + planImageLinksSection(images);
  // The placer is called with the provenance line (or nothing) and the wrapper is
  // applied by the SAME branch, so the two never disagree about who prepends the
  // italic line: `withProvenance` prepends it unconditionally, and the placer's
  // `trimStart` would eat the copy it prepends — leaving it doubled — unless the
  // placer is told the line is coming. Handed in, the placer emits it once and the
  // wrapper leaves it. Either way the line is FIRST and the HTML marker LAST.
  if (type === undefined || title === undefined) {
    // An absent type or title is a call site that has not been updated: the pre-
    // #1883 shape, so the wrapper runs exactly as it always did — no block, no
    // line, body byte-identical.
    return withProvenance(assembled, provenance);
  }
  const placed = provenance
    ? placePiSpecSection(assembled, type, title, provenanceLineOf(provenance))
    : placePiSpecSection(assembled, type, title);
  if (placed.omitted === undefined) {
    // The placer wrote the block at the top. When there is no provenance its body
    // IS the filing. When there is provenance, the placer also emitted the italic
    // line — so the body it returned has that line as its FIRST line and the
    // `withProvenance` wrapper below would prepend a SECOND copy. The wrapper is
    // therefore run on the body WITHOUT the placer's copy: it re-adds the identical
    // line first and appends the marker last, so both of its own rules still hold
    // (the italic line first, the marker last, and `provenanceReservation` remains
    // the only width story) while the placer's `trimStart` rule is preserved.
    if (!provenance) return placed.body;
    return withProvenance(placed.body.slice(provenanceLineOf(provenance).length + 2), provenance);
  }
  if (placed.spec !== undefined) {
    // The body ALREADY carried a block: it is kept and nothing is added — no
    // second block (two make `parsePiSpec` refuse the issue) and no line, because
    // there is no omission. `spec` being set alongside `omitted` is that case.
    return withProvenance(assembled, provenance);
  }
  // Nothing to contract (an epic, a spike, no criteria) or a failed read-back. The
  // placer returned the body unchanged in the first case and with the disclosure
  // line already on it in the second, so the wrapper only adds the two lines —
  // except that an EMPTY title (present but blank) is a real failure to contract
  // and must be disclosed, as a spec whose `problem` is empty would not parse.
  const disclosed =
    title.trim() === "" && !placed.body.includes(PI_SPEC_OMISSION_PREFIX)
      ? `${placed.body.trimEnd()}\n\n${PI_SPEC_OMISSION_PREFIX} no issue title to state the problem\n`
      : placed.body;
  return withProvenance(disclosed, provenance);
}
