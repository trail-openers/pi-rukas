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
 * it through the loop's `reviewCriteria` param, so classic /work cannot pass criteria
 * in and its reviewer's prompt is unchanged.
 *
 * The section opens with the spec's `problem`, because a review seat that
 * reads only the criteria list is a seat that never saw what the run was for: the
 * prose block is bounded at `MAX_ISSUE_CHARS`, and a statement past it lost its
 * tail at every review seat. Two payloads, two bounds — the statement at its own
 * cap and the list at its own, each saying so with its OWN marker, so a child
 * weighing a cut statement and a cut list can tell which half of its contract it
 * lost. The statement prints only when the list has a row to print beside it: a
 * spec that parses with no criteria renders no section at all.
 */
import { criteriaBlock } from "./spec-blocks.ts";
import { specFor } from "./spec-for.ts";
import type { ContractSource } from "./state-derived-spec.ts";
import { fenceText } from "./text-fence.ts";

/** The cap on the rendered criteria section — the bound the carried-findings block
 * at these same print sites already uses. */
const MAX_CRITERIA_CHARS = 20_000;

/** The cap on the statement the section opens with — the same bound as the list's,
 * so neither half is cut shorter by the other's length. */
const MAX_PROBLEM_CHARS = 20_000;

/** Each fence's own clip notice. Deliberately two different markers: two cuts that
 * read alike cannot be told apart by the child weighing them, and a seat cannot
 * weigh a cut contract it cannot locate. */
const CRITERIA_TRUNCATION_MARKER = "…(criteria truncated)";
const PROBLEM_TRUNCATION_MARKER = "…(problem truncated)";

/** Names where the ids come from, so a reviewer can cite one back. */
export const LEAN_REVIEW_CRITERIA_HEADING = "## The acceptance criteria (pi-spec v1)";

/** What the seat is told to do with the list. The `review` row of docs/lean.md
 * describes this section, so the docs and the sentence the child reads are a
 * two-sided change. */
export const LEAN_REVIEW_CRITERIA_LEAD =
  "Every criterion below is a requirement of this issue, printed in full up to its own cap, with its own marker when that cap cut it. A finding whose fix would contradict one is not a finding.";

/** What the seat is told the block above the list is, and what to make of the prose it
 * may have come from. Both halves hold on both shapes: the prose is always the shorter-
 * bound thing, and where it only restates this statement the renderer omits it — so the
 * sentence never claims the brief contains issue text it does not. */
export const LEAN_REVIEW_PROBLEM_LEAD =
  "The statement of the problem this run is for, printed in full up to its own cap, with its own marker when that cap cut it. The issue's prose is bounded far shorter, and is omitted when it only restates this, so this is the whole of what the run was asked to do.";

/** The statement's payload: `fenceText`'s disarm at its own cap. The marker is handed
 * to the renderer rather than substituted into its output, so issue text that quotes the
 * OTHER payload's marker cannot be mistaken for this fence's cut. */
function fenceProblem(problem: string): string {
  return fenceText(problem, MAX_PROBLEM_CHARS, PROBLEM_TRUNCATION_MARKER);
}

/** The criteria's payload, bounded and marked the same way over its own cap. */
function fenceCriteria(block: string): string {
  return fenceText(block, MAX_CRITERIA_CHARS, CRITERIA_TRUNCATION_MARKER);
}

/**
 * The section as a seat reads it, or `""`: no body, no parsable block, no criteria.
 *
 * The statement is gated on the list rendering at least one row, so the two calls
 * that read this section — `seatIssueBody` and `renderReviewIssueBlock`, both of
 * which strip the raw block on the same `!== ""` test — never strip a body whose
 * contract the section did not deliver. Every reader calls this one function
 * rather than deciding for itself whether to render, so the section a seat is
 * handed and the section that decided whether to hand it one are the same render.
 */
export function renderSpecCriteriaSection(
  rawBody: string | undefined,
  run: ContractSource = {},
): string {
  if (rawBody === undefined || rawBody.trim() === "") return "";
  // The accessor, so the criteria a seat is judged against are the criteria the
  // run was built to. A run with no contract anywhere still returns `""` and the
  // raw-body fallbacks elsewhere stay in force.
  const read = specFor(rawBody, run);
  if (!read.ok) return "";
  const block = criteriaBlock(read.spec);
  if (block.trim() === "") return "";
  const lead = `${LEAN_REVIEW_PROBLEM_LEAD}\n\n${fenceProblem(read.spec.problem)}\n\n`;
  return `${LEAN_REVIEW_CRITERIA_HEADING}\n\n${LEAN_REVIEW_CRITERIA_LEAD}\n\n${lead}${fenceCriteria(block)}`;
}
