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
