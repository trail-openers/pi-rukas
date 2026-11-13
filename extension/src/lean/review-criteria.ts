/**
 * lean/review-criteria — the spec's acceptance criteria as one review section.
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
 */
import { criteriaBlock } from "./spec-blocks.ts";
import { parsePiSpec } from "./spec.ts";
import { fenceText } from "./text-fence.ts";

/** The cap on the rendered criteria section — the bound the carried-findings block
 * at these same print sites already uses. */
const MAX_CRITERIA_CHARS = 20_000;

/** What the criteria fence says when it clipped. Deliberately NOT the prose block's
 * marker: two cuts that read alike cannot be told apart by the child weighing them. */
const CRITERIA_TRUNCATION_MARKER = "…(criteria truncated)";

/** `fenceText`'s own clip notice, which the marker replaces: it counts characters
 * kept, not criteria lost. Concatenated so this file's prose can name the notice
 * without the substitution matching its own description. */
const FENCE_CLIP_NOTICE = new RegExp(`\\[truncated at \\d+ char${"acters"}\\]`);

/** Names where the ids come from, so a reviewer can cite one back. */
export const LEAN_REVIEW_CRITERIA_HEADING = "## The acceptance criteria (pi-spec v1)";

/** What the seat is told to do with the list. */
export const LEAN_REVIEW_CRITERIA_LEAD =
  "Every criterion below is a requirement of this issue, printed in full and never truncated by the issue's own length. A finding whose fix would contradict one is not a finding.";

/** The section as a seat reads it, or `""`: no body, no parsable block, no criteria. */
export function renderSpecCriteriaSection(rawBody: string | undefined): string {
  if (rawBody === undefined || rawBody.trim() === "") return "";
  const parsed = parsePiSpec(rawBody);
  if (!parsed.ok) return "";
  const block = criteriaBlock(parsed.spec);
  if (block.trim() === "") return "";
  const overCap = block.length > MAX_CRITERIA_CHARS;
  const disarmed = fenceText(block, MAX_CRITERIA_CHARS);
  return `${LEAN_REVIEW_CRITERIA_HEADING}\n\n${LEAN_REVIEW_CRITERIA_LEAD}\n\n${
    overCap ? disarmed.replace(FENCE_CLIP_NOTICE, CRITERIA_TRUNCATION_MARKER) : disarmed
  }`;
}
