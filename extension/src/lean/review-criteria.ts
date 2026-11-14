import { leanReviewProblemEnabled } from "./review-problem-switch.ts";
/**
 * lean/review-criteria — the spec's own words as one review section.
 *
 * The lean review seats read the issue's prose and its `pi-spec v1` block as one
 * bounded string, so a long statement cut the block and the statement's own tail.
 * The prose half of the split is `review-spec-split.ts`; this is the criteria half.
 *
 * `criteriaBlock` — the renderer the `build`, `specify` and `challenge` prompts
 * print (`lean/spec-blocks.ts`) — keeps the wording a run is judged on and the
 * wording its reviewers read in one place, and `fenceText` disarms the result like
 * every other cross-boundary value at these print sites. The adversarial seat gets
 * it through the loop's `reviewCriteria` param, and the switch lives in
 * `review-spec-split.ts` — not on the loop's params, so classic /work cannot pass
 * criteria in and its reviewer's prompt is unchanged by this feature.
 *
 * The section opens with the spec's `problem` (#2265), because a review seat that
 * reads only the criteria list is a seat that never saw what the run was for: the
 * prose block is bounded at `MAX_ISSUE_CHARS`, and a statement past it lost its
 * tail at every review seat. Two payloads, two bounds — the statement at its own
 * cap and the list at its own, each saying so with its OWN marker, so a child
 * weighing a cut statement and a cut list can tell which half of its contract it
 * lost. The statement prints only when the list has a row to print beside it: a
 * spec that parses with no criteria renders no section at all and the seat keeps
 * today's raw bounded fallback (`readiness()`, not `parsePiSpec()`, is what makes
 * that shape unreachable on a real run).
 */
import { criteriaBlock } from "./spec-blocks.ts";
import { parsePiSpec } from "./spec.ts";
import { fenceText } from "./text-fence.ts";

/** The cap on the rendered criteria section — the bound the carried-findings block
 * at these same print sites already uses. */
const MAX_CRITERIA_CHARS = 20_000;

/** The cap on the statement the section opens with — the same bound as the list's,
 * so neither half is cut shorter by the other's length. */
const MAX_PROBLEM_CHARS = 20_000;

/** What the criteria fence says when it clipped. Deliberately NOT the prose block's
 * marker: two cuts that read alike cannot be told apart by the child weighing them. */
const CRITERIA_TRUNCATION_MARKER = "…(criteria truncated)";

/** What the statement's fence says when IT clipped — its own words, for the same
 * reason: a seat cannot weigh a cut contract it cannot locate. */
const PROBLEM_TRUNCATION_MARKER = "…(problem truncated)";

/** `fenceText`'s own clip notice, which the markers replace: it counts characters
 * kept, not criteria or sentences lost. Concatenated so this file's prose can name
 * the notice without the substitution matching its own description. */
const FENCE_CLIP_NOTICE = new RegExp(`\\[truncated at \\d+ char${"acters"}\\]`);

/** Names where the ids come from, so a reviewer can cite one back. */
export const LEAN_REVIEW_CRITERIA_HEADING = "## The acceptance criteria (pi-spec v1)";

/** What the seat is told to do with the list. Wording that the `review` row of
 * docs/lean.md restates and `test-lean-review-spec-split-switch.ts` greps, so the
 * needle and the sentence move together. */
export const LEAN_REVIEW_CRITERIA_LEAD =
  "Every criterion below is a requirement of this issue, printed in full up to its own cap, with its own marker when that cap cut it. A finding whose fix would contradict one is not a finding.";

/** What the seat is told the block above the list is, and what to make of the
 * prose it may have come from. Both halves hold on both shapes: the prose is
 * always the shorter-bound thing, and on the shape where it only restates this
 * statement the renderer omits it — so the sentence never claims the brief
 * contains issue text it does not. */
export const LEAN_REVIEW_PROBLEM_LEAD =
  "The statement of the problem this run is for, printed in full up to its own cap, with its own marker when that cap cut it. The issue's prose is bounded far shorter, and is omitted when it only restates this, so this is the whole of what the run was asked to do.";

/** The statement's payload: `fenceText`'s disarm at its own cap, with the generic
 * clip notice swapped for a marker that names WHICH payload was cut. Substitution
 * is anchored to this payload, so a criteria clip can never rewrite it (or the
 * other way round). */
function fenceProblem(problem: string): string {
  const overCap = problem.length > MAX_PROBLEM_CHARS;
  const disarmed = fenceText(problem, MAX_PROBLEM_CHARS);
  return overCap ? disarmed.replace(FENCE_CLIP_NOTICE, PROBLEM_TRUNCATION_MARKER) : disarmed;
}

/** The criteria's payload, bounded and marked the same way over its own cap. */
function fenceCriteria(block: string): string {
  const overCap = block.length > MAX_CRITERIA_CHARS;
  const disarmed = fenceText(block, MAX_CRITERIA_CHARS);
  return overCap ? disarmed.replace(FENCE_CLIP_NOTICE, CRITERIA_TRUNCATION_MARKER) : disarmed;
}

/**
 * The section as a seat reads it, or `""`: no body, no parsable block, no criteria.
 *
 * The statement is gated on the list rendering at least one row, so the two calls
 * that read this section — `seatIssueBody` and `renderReviewIssueBlock`, both of
 * which strip the raw block on the same `!== ""` test — never strip a body whose
 * contract the section did not deliver. It is gated on the statement's own switch
 * too, read at call time here rather than at the two print sites, so the section a
 * seat is handed and the section that decided whether to hand it one are the same
 * render: two readers of one knob, read at two moments, is how an off state ends
 * up printing half of itself.
 */
export function renderSpecCriteriaSection(rawBody: string | undefined): string {
  if (rawBody === undefined || rawBody.trim() === "") return "";
  const parsed = parsePiSpec(rawBody);
  if (!parsed.ok) return "";
  const block = criteriaBlock(parsed.spec);
  if (block.trim() === "") return "";
  const lead = leanReviewProblemEnabled()
    ? `${LEAN_REVIEW_PROBLEM_LEAD}\n\n${fenceProblem(parsed.spec.problem)}\n\n`
    : "";
  return `${LEAN_REVIEW_CRITERIA_HEADING}\n\n${LEAN_REVIEW_CRITERIA_LEAD}\n\n${lead}${fenceCriteria(block)}`;
}
