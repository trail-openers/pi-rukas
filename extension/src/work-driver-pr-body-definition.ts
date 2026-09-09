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
 *
 * Workstream consolidation lines remain mechanized-only since the fallback
 * LLM lacks the structured workstream data — this exception is recorded here.
 */

import { carriedAdversarialFindings, renderCarriedFindings } from "./adversarial-findings.ts";
import { renderAssumptions } from "./work-driver-intent.ts";
import { activeIssuesOf, scratchDir } from "./work-driver-workspace.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

/**
 * Type matching the normalisedSpec field in PipelineState from workflow-state-schema.ts.
 * This matches what's actually stored in the state file, which uses string for
 * evidence verdicts rather than the literal types used in NormalisedSpec.
 */
export interface PipelineStateNormalisedSpec {
  intent: string;
  deliverables: { id: string; description: string; paths: string[] }[];
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
    deliverables: spec.deliverables,
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
 * Generate the carried adversarial findings section from the event log.
 * Returns empty string if no findings.
 */
export function carriedFindingsSectionOf(eventLog: readonly WorkEvent[]): string {
  const findings = carriedAdversarialFindings(eventLog);
  return renderCarriedFindings(findings);
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
