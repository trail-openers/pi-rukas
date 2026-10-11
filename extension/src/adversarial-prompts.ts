/**
 * adversarial-prompts — what each half of the loop is told.
 *
 * Measured on nessie #664's five real spawns, the information flow was:
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

/** Keeps a pathological issue body from crowding out the diff. */
const MAX_ISSUE_CHARS = 6000;

function issueSection(issueBody: string | undefined): string {
  const trimmed = issueBody?.trim();
  if (!trimmed) return "";
  const body =
    trimmed.length > MAX_ISSUE_CHARS
      ? `${trimmed.slice(0, MAX_ISSUE_CHARS)}\n…(issue truncated)`
      : trimmed;
  return `\n\nWhat this change was asked to do — judge the diff against THIS, not against generic code quality. A diff that works but violates a stated constraint is a finding:\n\n${body}`;
}

/**
 * Reviewer instruction for the comment DATA block (#1040). Shared with the
 * six-lens context builder so every reviewer judges removals the same way.
 */
export const COMMENT_JUDGEMENT_PROSE =
  "Judge each removal listed above. LEGITIMATE: the code the comment described was removed or rewritten, or the comment was replaced by an equivalent. LOSS: the comment still documents code that exists at head, or it carried a constraint or rationale nothing else records. Report an unjustified loss as an ISSUES finding; do not report a legitimate removal. If the check was NOT CHECKED, review the comment changes in the diff yourself.";

export function buildAdversarialPrompt(opts: {
  diff: string;
  context: string;
  round: number;
  maxRounds: number;
  issueBody?: string;
  /** The "Comments removed by this change" data block (#1040); empty when none. */
  commentEvidence?: string;
}): string {
  const commentSection = opts.commentEvidence
    ? `\n\n${opts.commentEvidence}\n\n${COMMENT_JUDGEMENT_PROSE}`
    : "";
  return `You are reviewing the diff below. Context: ${opts.context}
Round: ${opts.round} of ${opts.maxRounds}.

Attack this implementation. Find edge cases, security holes, race conditions, API misuse, flawed assumptions. Run lint/type/test if any. Return a verdict line at the end exactly matching one of:
  VERDICT: APPROVED
  VERDICT: MINOR_OBSERVATIONS
  VERDICT: ISSUES_FOUND
  VERDICT: CRITICAL_ISSUES_FOUND

Use the severity your role prompt defines. Only CRITICAL_ISSUES_FOUND blocks the commit; the others are recorded and carried into the pull request. Inflating a finding's severity to avoid approving is the worst failure mode of this role.${issueSection(opts.issueBody)}${commentSection}

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
