/**
 * adversarial-prompts — what each half of the loop is told.
 *
 * Measured on lantern #664's five real spawns, the information flow was:
 *
 *   round 1 reviewer  — the diff, plus a one-sentence context
 *   round 1 fixer     — the reviewer's *entire reply* as "findings", including
 *                       mid-task narration. No diff. No issue.
 *   round 2 reviewer  — the round-1 diff again, unchanged
 *   round 2 fixer     — round-2 findings only; round 1's absent
 *   round 3 reviewer  — the round-1 diff again
 *
 * Two consequences, both observed:
 *
 *   1. The reviewer had no anchor. It noticed the staleness itself — *"The
 *      diff's original bugs … were already fixed in the working tree"* — and
 *      recovered by reading the live worktree, which is why every round found
 *      new ground instead of repeating. But a reviewer with no record of what
 *      it objected to last time cannot recognise convergence; it just keeps
 *      finding narrower things until the rounds run out.
 *   2. Nobody saw the issue. #664's explicit constraint ("must reuse
 *      `parse_assumptions` at src/synthesizer/parsing.rs:42-61") survived all
 *      three rounds unflagged, while a low-probability edge case blocked the
 *      cycle. Generic code quality was all anyone was given, so generic code
 *      quality is what got graded. This is #278.
 *
 * The issue body is optional throughout: cycles resumed from older state files
 * have no `issueBodyArtifact`, and a missing spec must degrade to the old
 * behaviour rather than putting the string "undefined" in front of a reviewer.
 */

import { COMMENT_JUDGEMENT_PROSE } from "./comment-evidence.ts";

/** Keeps a pathological issue body from crowding out the diff. */
const MAX_ISSUE_CHARS = 6000;

/**
 * #1137 — one workstream's declared scope as the per-workstream reviewer sees
 * it. The `id` is the workstream key the cycle's state names it by (e.g.
 * "docs", "delta-core"); the `scope` is the plan's one-line scope sentence and
 * `paths` are the declared paths (the fence the workstream is judged within).
 */
export interface SiblingScope {
  /** The workstream id the cycle keys it by. */
  id: string;
  /** The workstream's declared scope sentence from the plan. */
  scope: string;
  /** The workstream's declared paths. */
  paths: string[];
}

/**
 * #1137 — the per-workstream scope section. The per-workstream adversarial
 * prompt is told, explicitly, which part of the issue THIS workstream owns and
 * which parts belong to siblings. Without this, a docs-only workstream is
 * graded against the code workstream's criteria (the #1128 shape) and parks
 * with "byte-identical — nothing was fixed".
 *
 * Returns "" when `own` is absent (single-workstream cycle, or a state file
 * with no workstream declared) — the caller must not emit an empty scope
 * section for N=1: the whole issue IS the scope there, and the old prompt is
 * byte-identical to the pre-#1137 one.
 *
 * The section names sibling workstreams by id + scope + paths so the reviewer
 * can see exactly what is out of scope. It does NOT re-state the acceptance
 * criteria (those live in the issue body) — the exclusion is by workstream
 * ownership, not by re-paraphrasing the issue.
 */
export function buildWorkstreamScopeSection(
  own: SiblingScope | undefined,
  siblings: readonly SiblingScope[],
): string {
  // N=1 (no siblings, no own): the whole issue is this workstream's scope —
  // the pre-#1137 behaviour. No section is emitted; the issue body below is
  // passed verbatim and the reviewer judges the diff against it.
  if (!own && siblings.length === 0) return "";
  const ownLine = own
    ? `This workstream owns: ${own.scope ? `"${own.scope}"` : "(no scope recorded)"} — declared paths: ${own.paths.length ? own.paths.join(", ") : "(none recorded)"}`
    : "This workstream's own scope is not recorded in the cycle state (scope unknown — do not guess, do not default to the whole issue).";
  const sibLines =
    siblings.length > 0
      ? siblings
          .map(
            (s) =>
              `  - ${s.id}: ${s.scope ? `"${s.scope}"` : "(no scope recorded)"} — ${s.paths.length ? s.paths.join(", ") : "(no paths recorded)"}`,
          )
          .join("\n")
      : "  (no sibling workstreams)";
  return `
WORKSTREAM SCOPE (this review is scoped to ONE workstream of the issue):
${ownLine}
Out of scope for this review — the following criteria are owned by sibling workstreams and are NOT judged against this diff. A sibling-owned criterion is NOT a finding even if it appears unmet here; the consolidated check (after all workstreams) is the only place that criterion is judged. Do not flag a sibling-owned criterion as a finding.
${sibLines}`;
}

function issueSection(issueBody: string | undefined): string {
  const trimmed = issueBody?.trim();
  if (!trimmed) return "";
  const body =
    trimmed.length > MAX_ISSUE_CHARS
      ? `${trimmed.slice(0, MAX_ISSUE_CHARS)}\n…(issue truncated)`
      : trimmed;
  return `\n\nWhat this change was asked to do — judge the diff against THIS, not against generic code quality. A diff that works but violates a stated constraint is a finding:\n\n${body}`;
}

export function buildAdversarialPrompt(opts: {
  diff: string;
  context: string;
  round: number;
  maxRounds: number;
  issueBody?: string;
  /** The "Comments removed by this change" data block (#1040); empty when none. */
  commentEvidence?: string;
  /**
   * #1137 — the workstream's own declared scope (absent on N=1 / no-state
   * shapes, where the whole issue is the scope and no section is emitted).
   * When present, the issue section is replaced by the scope-scoped variant:
   * the issue body is still passed (the reviewer needs the context) but the
   * scope section makes explicit which part of it belongs to THIS workstream
   * and which parts belong to siblings (which are excluded from findings).
   */
  scope?: { own?: SiblingScope; siblings: readonly SiblingScope[] };
  /**
   * The "changed by the last fix pass" section (fix-delta.ts); empty when this
   * review does not follow a fix pass or the delta could not be stated.
   */
  fixDelta?: string;
}): string {
  const commentSection = opts.commentEvidence
    ? `\n\n${opts.commentEvidence}\n\n${COMMENT_JUDGEMENT_PROSE}`
    : "";
  const scopeSection = opts.scope
    ? buildWorkstreamScopeSection(opts.scope.own, opts.scope.siblings)
    : "";
  return `You are reviewing the diff below. Context: ${opts.context}
Round: ${opts.round} of ${opts.maxRounds}.

Attack this implementation. Find edge cases, security holes, race conditions, API misuse, flawed assumptions. Run lint/type/test if any. Return a verdict line at the end exactly matching one of:
  VERDICT: APPROVED
  VERDICT: MINOR_OBSERVATIONS
  VERDICT: ISSUES_FOUND
  VERDICT: CRITICAL_ISSUES_FOUND

Use the severity your role prompt defines. Only CRITICAL_ISSUES_FOUND blocks the commit; the others are recorded and carried into the pull request. Inflating a finding's severity to avoid approving is the worst failure mode of this role.${scopeSection}${issueSection(opts.issueBody)}${commentSection}${opts.fixDelta ?? ""}

Diff:
\`\`\`diff
${opts.diff}
\`\`\``;
}

export function buildFixPrompt(opts: {
  findings: string;
  context: string;
  diff: string;
  round: number;
  issueBody?: string;
  priorFindings?: string[];
}): string {
  const prior = (opts.priorFindings ?? []).filter((p) => p.trim());
  const priorSection = prior.length
    ? `\n\nAlready addressed in prior rounds — do not re-open or undo these; they are here so you do not regress them:\n${prior.map((p) => `- ${p}`).join("\n")}`
    : "";
  return `Fix the following adversarial review findings. Original context: ${opts.context}
Round ${opts.round} fix.

Findings:
${opts.findings}${priorSection}${issueSection(opts.issueBody)}

Make the minimal changes needed to address every finding. Run local quality gates before returning.

Current diff of the work so far:
\`\`\`diff
${opts.diff}
\`\`\``;
}
