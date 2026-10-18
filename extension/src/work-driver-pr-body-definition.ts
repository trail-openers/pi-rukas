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
 *   6. unmeasurablePathsSection: the #1155 deliverables whose `[paths:]` slot
 *      the converge gate could not check — a warning, never a cap, and a
 *      distinct surface again (an unmeasurable slot is "the gate gave up
 *      judging", not "the work is missing" and not an operator action).
 *
 * Workstream consolidation lines remain mechanized-only since the fallback
 * LLM lacks the structured workstream data — this exception is recorded here.
 */

import { carriedAdversarialFindings, renderCarriedFindings } from "./adversarial-findings.ts";
import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { declaresNoMeasurablePath } from "./work-driver-deliverable-paths.ts";
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
 * #1155 — the deliverables whose declared `[paths:]` slot the converge gate
 * cannot check: it parses to no concrete or glob alternative (`n/a — repo
 * settings`, a bare sentence, a placeholder in a shape the parser cannot
 * rescue). The predicate is the converge gate's own `declaresNoMeasurablePath`,
 * so a deliverable this function lists is exactly one the gate classified
 * `unmeasurable` — the PR body and the gate cannot disagree about which rows
 * went unchecked.
 */
export function unmeasurableDeliverables(
  spec: NormalisedSpec | PipelineStateNormalisedSpec | undefined,
): Array<PipelineStateNormalisedSpec["deliverables"][number]> {
  if (!spec) return [];
  const rows = spec.deliverables as Array<PipelineStateNormalisedSpec["deliverables"][number]>;
  return rows.filter((d) => (d.paths ?? []).length > 0 && declaresNoMeasurablePath(d.paths ?? []));
}

/**
 * #1155 — the warning block for unmeasurable deliverables, in the shape
 * `renderOperatorActions` uses: its own heading, non-blocking, and the
 * offending slot verbatim so the reader can tell which `[paths:]` to reword.
 * Returns "" when every deliverable names something checkable — the section
 * must not appear at all in its absence.
 *
 * Why it must be in the PR body and not only the trace: the issue's decided
 * rule is "a warning in the PR body/handoff, never a cap". A warning nobody
 * reads is a gate that silently stopped checking, which is the failure mode
 * #1240 exists to make visible.
 */
export function renderUnmeasurablePathsWarning(
  spec: NormalisedSpec | PipelineStateNormalisedSpec | undefined,
): string {
  const rows = unmeasurableDeliverables(spec);
  if (rows.length === 0) return "";
  return [
    "",
    "## Unmeasurable deliverables (warning — not blocking)",
    "",
    "The converge completeness gate could not check these deliverables: their declared `[paths:]` slot parses to no concrete or glob path, so there was nothing to look for in the diff. The work may well be done — it is simply not verifiable from the plan as written. Reword the slot to name a file, a directory, or a `<template>`:",
    "",
    ...rows.map(
      (d) => `- **${d.id}: ${d.description}** — \`[paths: ${(d.paths ?? []).join(", ")}]\``,
    ),
  ].join("\n");
}

/**
 * #1155 — the warning as a PR-body slice, shared by the mechanized commit-pr
 * path and the LLM-ops fallback prompt exactly as `operatorActionsSectionOf`
 * is, so both render the same text. Empty when there is nothing to show.
 */
export function unmeasurablePathsSectionOf(spec: PipelineStateNormalisedSpec | undefined): string {
  return renderUnmeasurablePathsWarning(spec);
}

/**
 * #1404 — the pre-existing-test-failures section for the PR body.
 *
 * When the commit-pr consolidated verify failed only on tests that ALSO fail
 * at the cycle's base commit, the cycle continues and pushes — but a PR whose
 * gate was red says nothing about that on its own, and the next person to
 * hit the red gate will spend their afternoon on this diff. The names are
 * printed so the record says plainly which failures the change did not cause.
 *
 * Returns "" when there is nothing to show (the section must not appear at
 * all in its absence, same contract as the operator-actions section). The
 * followup path — where the PR already exists and no body is built — records
 * the same text on `plumbReports` instead, which the handoff renders.
 */
export function preExistingFailuresSectionOf(names: readonly string[] | undefined): string {
  if (!names || names.length === 0) return "";
  return [
    "",
    "## Pre-existing test failures",
    "",
    `The commit-pr consolidated verify failed, but every failing test \u2014 ${names.length} of them \u2014 also fails on a clean checkout of this PR's base commit, so none of them is caused by this change:`,
    "",
    ...names.map((n) => `- \`${neutraliseMarkdownField(n)}\``),
    "",
    "These are gate failures owned by the base commit, not by this PR. They are listed rather than excused silently so the next reviewer (and the next cycle, which parks on the same red gate) can tell the two apart.",
  ].join("\n");
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

// ── #1006 — TL;DR section ─────────────────────────────────────────────────────

/**
 * #1006 — the TL;DR heading constant. Used as the idempotency anchor for
 * the issue-body edit: a body that already contains a line matching
 * `/^##\s+TL;?DR/m` is NOT edited again (no double-prepend).
 */
export const TLDR_HEADING = "## TL;DR";

/**
 * #1006 — detect whether a body already carries a TL;DR section.
 * Anchored on the heading text (case-sensitive `## TL;DR` or the variant
 * `## TLDR`), not on arbitrary marker comments — so a prior hand-written
 * TLDR with the same heading is recognised and the edit is a no-op.
 *
 * Tolerates leading whitespace (a table-of-contents line like
 * `   ## TL;DR` is still a TL;DR heading).
 */
export function hasTldrSection(body: string): boolean {
  return /^\s*##\s+TL;?DR\b/im.test(body);
}

/**
 * #1006 — derive a short plain-language TL;DR from the normalised spec.
 *
 * Source: driver-side deterministic derivation (no LLM dispatch).
 *   - First sentence of `spec.intent` (the one-sentence "what this does")
 *   - The first deliverable description (the most important change)
 *   - Both are clipped to keep the total ≤ 400 chars.
 *
 * Returns `""` when `spec` is absent, has no intent, or has no deliverables
 * (the module's established empty-string contract: an empty section is
 * filtered out by `mechanizedCommitPr`'s `.filter((l) => l !== "")` and by
 * the `inlineCommitPrPrompt`'s `bodySections` filter).
 */
export function tldrSectionOf(spec: PipelineStateNormalisedSpec | undefined): string {
  if (!spec || !spec.intent || spec.intent.trim() === "") return "";
  const intent = spec.intent.trim();
  // First sentence (up to the first period followed by whitespace or end).
  const firstSentence = intent.match(/^(.+?)(?:\.(?:\s|$)|\s*\.{2,})/)?.[1]?.trim();
  const lead = (firstSentence && firstSentence.length > 10 ? firstSentence : intent).trim();
  const deliverables = spec.deliverables.filter((d) => d.description?.trim());
  if (deliverables.length === 0) return "";
  const desc = (deliverables[0]?.description ?? "").trim();
  // Build the text, capped at 400 chars total.
  const cap = 400;
  let text = lead;
  if (text.length > cap) text = `${text.slice(0, cap - 1)}\u2026`;
  else {
    if (desc.length > 0) {
      const joined = `${text} ${desc}`;
      if (joined.length <= cap) {
        text = joined;
      } else {
        text = `${text.slice(0, Math.max(0, cap - 1))}\u2026`;
      }
    }
  }
  return `${TLDR_HEADING}\n\n${text}`;
}

/**
 * #1006 — build the full new body for an issue: the TL;DR section
 * prepended above the existing body. `existingBody` is the CURRENT body
 * (read live from the forge, not a cached snapshot), so concurrent user
 * edits are preserved.
 *
 * If the body already carries a TL;DR heading, returns `existingBody`
 * unchanged (idempotency: no second block is prepended).
 */
export function prependTldr(existingBody: string, tldr: string): string {
  if (tldr === "" || hasTldrSection(existingBody)) return existingBody;
  return `${tldr}\n\n${existingBody}`;
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
