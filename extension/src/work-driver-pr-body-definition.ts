/**
 * work-driver-pr-body-definition — shared definition of PR body sections.
 *
 * Both the mechanized commit-pr path (work-driver-commit.ts) and the
 * LLM ops fallback prompt (work-driver-prompts-late.ts:inlineCommitPrPrompt)
 * consume this definition to ensure they produce the same required sections.
 *
 * Sections:
 *   1. fixesLines: one `Fixes #N` per active issue
 *   2. companionLines: a `Companion to #N` line per dropped issue
 *   3. assumptionsBlock: from renderAssumptions (passed as quoted text to fallback)
 *   4. carriedFindings: from renderCarriedFindings (passed as quoted text to fallback)
 *   5. operatorActionsSection: the #792 no-diff deliverables — a DISTINCT
 *      surface from the assumptions block (a declared deliverable with a
 *      status is not an assumption; rendering it under "Assumptions" would
 *      misrepresent it).
 *
 * Workstream consolidation lines remain mechanized-only since the fallback
 * LLM lacks the structured workstream data — this exception is recorded here.
 */

import { carriedAdversarialFindings, renderCarriedFindings } from "./adversarial-findings.ts";
import { renderAssumptions } from "./work-driver-intent.ts";
import type { NormalisedSpec } from "./work-driver-intent.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * Type matching the normalisedSpec field in PipelineState from workflow-state-schema.ts.
 * This matches what's actually stored in the state file, which uses string for
 * evidence verdicts rather than the literal types used in NormalisedSpec.
 */
export interface PipelineStateNormalisedSpec {
  intent: string;
  deliverables: Array<{
    id: string;
    description: string;
    paths: string[];
    /** #792 — optional; set by the plan-time parser for honoured markers. */
    noDiff?: boolean;
    /** #792 — evidence string for an honoured no-diff marker. */
    noDiffEvidence?: string;
  }>;
  acceptanceCriteria: string[];
  outOfScope: string[];
  assumptions: { text: string; basis: string }[];
  openQuestions: string[];
  evidence: { claim: string; source: string; verdict: string }[];
  verdict: "proceed" | "proceed-with-assumptions" | "park";
  parkReason?: string;
  rationale: string;
}

/**
 * Generate the fixes lines: one `Fixes #N` per active issue.
 */
export function fixesLinesOf(issues: number[]): string[] {
  return issues.map((n) => `Fixes #${n}`);
}

/**
 * Generate the companion lines: a `Companion to #N` line per dropped issue.
 */
export function companionLinesOf(
  droppedIssues: Array<{ issue: number; verdict: string; reason: string }>,
): string[] {
  return droppedIssues.map(
    (d) =>
      `Companion to #${d.issue} (${d.verdict}: ${d.reason || "no reason given"}; left untouched).`,
  );
}

/**
 * Generate the assumptions block from a pipeline state normalised spec.
 * Returns empty string if no assumptions.
 */
export function assumptionsBlockOf(spec: PipelineStateNormalisedSpec | undefined): string {
  if (!spec) return "";
  // Convert to the format expected by renderAssumptions
  const normalizedSpec: import("./work-driver-intent.ts").NormalisedSpec = {
    intent: spec.intent,
    deliverables: spec.deliverables as unknown as NormalisedSpec["deliverables"],
    acceptanceCriteria: spec.acceptanceCriteria,
    outOfScope: spec.outOfScope,
    assumptions: spec.assumptions,
    openQuestions: spec.openQuestions,
    evidence: (spec.evidence ?? []).map((e) => ({
      claim: e.claim,
      source: e.source,
      verdict: e.verdict as import("./work-driver-intent.ts").SpecEvidence["verdict"],
    })),
    verdict: spec.verdict,
    parkReason: spec.parkReason as import("./work-driver-intent.ts").ParkReason | undefined,
    rationale: spec.rationale,
  };
  return renderAssumptions(normalizedSpec);
}

/**
 * #792 — a no-diff deliverable is one the plan flagged as producing no
 * code by design (a settings toggle, an operator action, a manual
 * verification step) — it classifies `no-diff` at the converge gate and
 * must surface as an operator action rather than vanish from the record.
 * Only an HONORED marker qualifies: `noDiff` is set by the parser (or the
 * artifact twin) only when the evidence string was present at plan time,
 * so no second check is needed here.
 * Accepts both spec shapes (the live NormalisedSpec and the persisted
 * PipelineStateNormalisedSpec, whose deliverable entries are a structural
 * subset — the noDiff fields, when present, are identical in shape).
 */
export function noDiffDeliverables(
  spec: NormalisedSpec | PipelineStateNormalisedSpec | undefined,
): Array<PipelineStateNormalisedSpec["deliverables"][number]> {
  if (!spec) return [];
  const rows = spec.deliverables as Array<PipelineStateNormalisedSpec["deliverables"][number]>;
  return rows.filter((d) => d.noDiff === true);
}

/**
 * #792 — the operator-actions block for the PR body (and the completion
 * message). Mirrors the `partialWarning` shape in work-driver-explain.ts:
 * its own heading, non-blocking, evidence string verbatim so the operator
 * sees WHAT was to be done. Returns "" when the spec has no no-diff
 * deliverable — the section must not appear at all in its absence.
 */
export function renderOperatorActions(
  spec: NormalisedSpec | PipelineStateNormalisedSpec | undefined,
): string {
  const rows = noDiffDeliverables(spec);
  if (rows.length === 0) return "";
  return [
    "",
    "## Operator actions (no-diff deliverables)",
    "",
    "These deliverables were declared at plan time as producing NO diff by design. The converge gate skipped their diff check; the operator (or ops) performs them outside this PR:",
    "",
    ...rows.map(
      (d) => `- **${d.id}: ${d.description}** — ${d.noDiffEvidence ?? "(no evidence recorded)"}`,
    ),
  ].join("\n");
}

/**
 * #792 — the operator-actions section as a PR-body slice, shared by the
 * mechanized commit-pr path (work-driver-commit.ts) and the LLM-ops
 * fallback prompt (work-driver-prompts-late.ts:inlineCommitPrPrompt) so
 * both render the same text. Empty when there is nothing to show.
 */
export function operatorActionsSectionOf(spec: PipelineStateNormalisedSpec | undefined): string {
  return renderOperatorActions(spec);
}

/**
 * Generate the carried adversarial findings section from the event log.
 * Returns empty string if no findings.
 */
export function carriedFindingsSectionOf(eventLog: readonly WorkEvent[]): string {
  const findings = carriedAdversarialFindings(eventLog);
  return renderCarriedFindings(findings);
}

/**
 * #792 — findings count for the plan-quality gate. Excludes no-diff
 * deliverables so a settings toggle cannot push a 4-deliverable plan into a
 * phantom `under-decomposed` re-dispatch. Returns 0 for an absent spec
 * (the caller then falls back to countFindingsForCycle — unchanged).
 */
export function planFindingsCount(spec: PipelineStateNormalisedSpec | undefined): number {
  if (!spec || spec.deliverables.length === 0) return 0;
  return spec.deliverables.filter((d) => d.noDiff !== true).length;
}

// #507 — clip a PR title to a code-unit budget at a word boundary.
// Budget 64 (not 72): GitHub squash-merge appends ` (#<N>)`.
export function clipTitle(raw: string, budget: number): string {
  if (raw.length <= budget) return raw;
  let cut = budget - 1; // reserve one code unit for the ellipsis
  // Rule 4 — never leave a dangling high surrogate: if the cut falls between
  // the two halves of a surrogate pair (high half at cut-1 in the prefix, low
  // half at cut in the dropped tail), step the cut back so the pair is cut
  // whole. The high half can only sit at cut-1 when the low half sits at
  // cut, so checking the cut position for a low surrogate is sufficient.
  if (cut < raw.length) {
    const at = raw.charCodeAt(cut);
    const before = raw.charCodeAt(cut - 1);
    if (
      (at >= 0xdc00 && at <= 0xdfff && before >= 0xd800 && before <= 0xdbff) ||
      (at >= 0xd800 && at <= 0xdbff)
    ) {
      cut -= 1;
    }
  }
  // Rule 5 — last whitespace at or before cut; prefix after trimEnd must be
  // non-empty (a boundary at index 0 would otherwise yield a bare ellipsis).
  for (let i = cut; i >= 0; i--) {
    const ch = raw.charAt(i);
    if (/\s/.test(ch) && raw.slice(0, i).trimEnd().length > 0) {
      return `${raw.slice(0, i).trimEnd()}\u2026`;
    }
  }
  // Rule 6 — no breakable boundary (a single unbreakable token over budget).
  // The one case where a word is cut mid-way: the alternative is an empty
  // title, which is worse. `cut` was already backed off the pair in rule 4.
  return `${raw.slice(0, cut)}\u2026`;
}
