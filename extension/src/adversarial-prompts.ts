/**
 * adversarial-prompts — what each half of the loop is told.
 *
 * Measured on five real spawns from one cycle, the information flow was:
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

import { type DiffRange, boundDiffForPrompt } from "./adversarial-diff-cap.ts";
import { COMMENT_JUDGEMENT_PROSE } from "./comment-evidence.ts";
import { fenceText } from "./lean/text-fence.ts";

/** Keeps a pathological issue body from crowding out the diff. Exported so
 * every site that prints an issue block bounds it the same way — a second
 * bound is a second rule about how much of the spec a child gets to read. */
export const MAX_ISSUE_CHARS = 6000;

/** The fence that opens/closes the prompt's diff block.
 *
 * `String.fromCharCode` keeps the backticks out of the source: the formatter
 * rewrites an escaped-backtick run inside a template literal and can turn a
 * fence into a terminator — the shape that silently truncated both prompts
 * before. One code point (0x60) repeated three times. */
const FENCE = String.fromCharCode(0x60, 0x60, 0x60);

/** Blank line separating the closing fence from the bound's truncation note,
 * which is prose printed AFTER the fence, never inside it (`boundDiffForPrompt`). */
const NOTE_SEP = "\n\n";

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

/** The lead-in every reviewer reads before the issue body, shared with the
 * /work review-side block (`work-driver-lens-issue.ts`) so the two cannot
 * disagree about what they are handing the child. One constant for the whole
 * prompt layer, so the rule cannot drift between a reviewer and a fixer. */
export const ISSUE_PROMPT_LEAD =
  "What this change was asked to do — judge it against THIS, not against generic code quality.";

/** The rule this loop's reviewer is held to: the diff is judged against the
 * spec, and a finding that can only be satisfied by contradicting the spec is
 * not a finding. Exported because the lean lens pass and fixer print the same
 * rule through their own fence renderer — one sentence, one site that owns it. */
export const ADVERSARIAL_FINDING_RULE =
  "A finding whose fix would require contradicting an explicit requirement of this issue is NOT a finding.";

/** The issue body, trimmed to `MAX_ISSUE_CHARS` with its truncation marker, or
 * `""` for an absent or blank body (which must print no block at all). Exported
 * so every site that prints an issue block bounds it the same way — a second
 * bound is a second rule about how much of the spec a child gets to read. */
export function boundedIssueBody(issueBody: string | undefined): string {
  const trimmed = issueBody?.trim();
  if (!trimmed) return "";
  return trimmed.length > MAX_ISSUE_CHARS
    ? `${trimmed.slice(0, MAX_ISSUE_CHARS)}\n…(issue truncated)`
    : trimmed;
}

/** The fixed text of `boundedIssueBody`'s truncation marker — the one marker any
 * issue block may carry. Declared next to the function that prints it so the
 * fence cap below and the assertions that count markers name it, not re-type it. */
export const ISSUE_TRUNCATION_MARKER = "\n…(issue truncated)";

/** `boundedIssueBody`'s text printed behind `fenceText` at a cap that can never
 * clip its truncation marker: the body's own bound plus the marker's own text
 * (and the newline it sits on). Every print site of an issue block uses this
 * renderer, so a block carries ONE marker and a reader never has to guess which
 * cut it is looking at. */
export function fencedIssueBody(issueBody: string | undefined): string {
  const body = boundedIssueBody(issueBody);
  if (body === "") return "";
  return fenceText(body, MAX_ISSUE_CHARS + ISSUE_TRUNCATION_MARKER.length + 1);
}

/**
 * The one renderer that prints an issue body into a brief whose untrusted text
 * is FENCED (the lean review layer, whose `fenceText` keeps a `### heading`
 * inside a body from opening a section of the prompt the step never wrote, and
 * keeps a ``` fence inside it from closing one the prompt opened). `render` is
 * applied to the body only, after the bound, so the lead-in and the rule stay
 * prompt prose and the truncation marker stays the layer's own.
 *
 * `rule` is what the child is told to do with the issue — a fixer shown the
 * spec without a rule is the fixer that "fixes" a finding by violating it.
 *
 * An absent or blank body yields `""`: no block, and never the string
 * "undefined".
 */
export function fencedIssuePromptBlock(
  issueBody: string | undefined,
  rule: string,
  render: (body: string) => string,
): string {
  const body = boundedIssueBody(issueBody);
  if (body === "") return "";
  return `\n\n${ISSUE_PROMPT_LEAD} ${rule}\n\n${render(body)}`;
}

/** The one sentence this fixer is held to about the issue. A fixer shown the
 * spec and not told what to do with it is the fixer that "fixes" a finding by
 * violating the ticket. Printed with the block rather than on its own: the
 * sentence is only actionable against the requirement it names. */
const FIXER_ISSUE_RULE =
  "Do not apply a finding that contradicts a requirement stated in the issue above — name it in your reply and leave the code the issue asked for.";

export function issueSection(issueBody: string | undefined): string {
  return fencedIssuePromptBlock(issueBody, ADVERSARIAL_FINDING_RULE, fencedIssueBody);
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
  /**
   * The project gate the /work driver runs itself (`driverGateCmd`). Present
   * only on the driver path: there the verify gate cleared this tree before the
   * review was dispatched, and a reviewer re-running it — nine minutes on one
   * measured project, twice in one round — proves nothing new. Absent on the
   * `adversarial_loop` tool path, where nobody has run anything.
   */
  gateCmd?: string;
  /**
   * The ref range this diff came from. Only used when the diff exceeds the
   * inline cap: the truncation notice mints `git diff <base>...<head>` from it
   * so the reviewer can read the files the bound cut. Absent for a pasted diff
   * or a round whose diff re-read failed.
   */
  diffRange?: DiffRange;
}): string {
  const commentSection = opts.commentEvidence
    ? `\n\n${opts.commentEvidence}\n\n${COMMENT_JUDGEMENT_PROSE}`
    : "";
  const scopeSection = opts.scope
    ? buildWorkstreamScopeSection(opts.scope.own, opts.scope.siblings)
    : "";
  const bounded = boundDiffForPrompt(opts.diff, opts.diffRange);
  const note = bounded.note ? NOTE_SEP + bounded.note : "";
  // #1992 — one constant for both arms: the lane rules AND the targeted-checks
  // sentence are the same on the driver path and the tool path, so they cannot
  // drift apart. The gateCmd arm adds only its own clause about the named gate.
  const laneRules =
    "Run only targeted checks — one test file, or a lint or type check of the changed files — never the whole-project suite. Do not debug a failure in code this diff did not change: report it in one line as a MINOR_OBSERVATION tagged `OUT_OF_DIFF`. Do not re-run an unchanged command against an unchanged tree to see whether its result changes. Do not create, edit or revert files in the worktree. Report your findings before your time runs out; an unfinished investigation is itself a finding that states what is known. When you have decided you are done, your very next message is the verdict report, with no further tool calls.";
  const checks = opts.gateCmd
    ? `Do NOT run the project's full gate — \`${opts.gateCmd}\` — or anything that wraps it or the whole test suite: the driver runs that exact command itself. Its verify gate had to clear this tree before you were dispatched, and it runs again on the consolidated tree before the pull request opens, so a re-run here costs the whole gate's wall-clock and proves nothing new.`
    : "";
  return `You are reviewing the diff below. Context: ${opts.context}
Round: ${opts.round} of ${opts.maxRounds}.

Attack this implementation. Find edge cases, security holes, race conditions, API misuse, flawed assumptions. ${checks} ${laneRules} Return a verdict line at the end exactly matching one of:
  VERDICT: APPROVED
  VERDICT: MINOR_OBSERVATIONS
  VERDICT: ISSUES_FOUND
  VERDICT: CRITICAL_ISSUES_FOUND

Use the severity your role prompt defines. Only CRITICAL_ISSUES_FOUND blocks the commit; the others are recorded and carried into the pull request. Inflating a finding's severity to avoid approving is the worst failure mode of this role.${scopeSection}${issueSection(opts.issueBody)}${commentSection}${opts.fixDelta ?? ""}

Diff:
${FENCE}diff
${bounded.diff}
${FENCE}${note}`;
}

export function buildFixPrompt(opts: {
  findings: string;
  context: string;
  diff: string;
  round: number;
  issueBody?: string;
  priorFindings?: string[];
  /** See `buildAdversarialPrompt.diffRange` — the ref range this diff came from,
   * which the truncation notice names when the diff is over the inline cap. */
  diffRange?: DiffRange;
}): string {
  const prior = (opts.priorFindings ?? []).filter((p) => p.trim());
  const priorSection = prior.length
    ? `\n\nAlready addressed in prior rounds — do not re-open or undo these; they are here so you do not regress them:\n${prior.map((p) => `- ${p}`).join("\n")}`
    : "";
  const bounded = boundDiffForPrompt(opts.diff, opts.diffRange);
  const note = bounded.note ? NOTE_SEP + bounded.note : "";
  // The issue is the author's text and this brief goes to a write-capable
  // developer, so it is disarmed at the print site like every other block that
  // crosses into a child — one `### heading` or a ``` fence inside it would
  // otherwise open a section of this prompt the driver never wrote.
  const issue = fencedIssuePromptBlock(opts.issueBody, FIXER_ISSUE_RULE, fencedIssueBody);
  return `Fix the following adversarial review findings. Original context: ${opts.context}
Round ${opts.round} fix.

Findings:
${opts.findings}${priorSection}${issue}

Make the minimal changes needed to address every finding. Run local quality gates before returning.

Current diff of the work so far:
${FENCE}diff
${bounded.diff}
${FENCE}${note}`;
}
