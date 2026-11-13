/**
 * lean/review-spec-split — the issue's prose and the spec's criteria as TWO
 * sections in front of the review seats.
 *
 * Every lean review seat (the six lenses, the adversarial reviewer, the fixer)
 * used to receive the raw issue body through the shared bounded renderer: one
 * `MAX_ISSUE_CHARS` budget covering the body AND its `pi-spec` block together. A
 * long statement therefore cut the machine block first — and, once the statement
 * alone passed the cap, it cut the statement's tail.
 *
 * This module splits the two, the way `lean/issue-prose.ts` splits them for the
 * oracle seats:
 *
 *   1. the prose is the body with its `pi-spec v1` block stripped
 *      (`stripPiSpecBlocks` on the RAW body, BEFORE any bound — a clip that lands
 *      inside the block leaves an unterminated fence the strip is obliged to keep),
 *      then bounded at `MAX_ISSUE_CHARS` with the layer's own truncation marker,
 *      so what survives the cut is prose;
 *   2. the criteria are rendered from the parsed spec (`criteriaBlock`, the same
 *      renderer the `build`/`specify`/`challenge` prompts print), so no criterion
 *      is ever cut by a prose bound;
 *   3. both are disarmed at the print site by `fenceText`, because a criterion's
 *      text is issue-author prose crossing into six children's briefs.
 *
 * `PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT=0` restores the single bounded block byte
 * for byte: with the switch off nothing here parses, strips or renders, and the
 * print sites take the call they take today. The reader is called at CALL time so
 * a smoke file can pin either arm with `withEnv` without one file's pin leaking
 * into the next.
 */
import {
  ADVERSARIAL_FINDING_RULE,
  ISSUE_PROMPT_LEAD,
  MAX_ISSUE_CHARS,
  fencedIssueBody,
  fencedIssuePromptBlock,
} from "../adversarial-prompts.ts";
import { renderSpecCriteriaSection } from "./review-criteria.ts";
import { stripPiSpecBlocks } from "./spec.ts";

/** Whether lean's review seats receive the split rendering. */
export function leanReviewSpecSplitEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT !== "0";
}

/**
 * The issue's own words for a review seat: the body with its spec block removed,
 * fenced and bounded exactly as every other issue block at these print sites is
 * (`fencedIssueBody`, so one `…(issue truncated)` marker and no fence clip).
 */
export function renderReviewProse(rawBody: string | undefined): string {
  return fencedIssueBody(stripPiSpecBlocks(rawBody ?? ""));
}

/** What the lead-in adds to the shared sentence when a criteria section follows:
 * the seat is told where the rest of the contract is, because the body it just
 * read no longer contains it. */
const CRITERIA_CLAUSE =
  " Its acceptance criteria are printed in their own section below and are not truncated by the issue's length.";

/**
 * The issue block a lean review seat receives with the split on: the stripped
 * prose and the criteria section, one lead-in over both.
 *
 * `rule` is the seat's own sentence about what to do with the requirements —
 * each print site keeps its copy, because the fixer's rule and a lens's rule are
 * not the same instruction. An absent or blank body yields `""`: no block, and
 * never the string "undefined".
 */
export function renderReviewIssueBlock(rawBody: string | undefined, rule: string): string {
  const prose = renderReviewProse(rawBody);
  if (prose === "") return "";
  const criteria = renderSpecCriteriaSection(rawBody);
  // With no parsable block the seat reads exactly what it read before the split:
  // same lead-in, same rule, same fenced body. A body that never carried a spec
  // cannot tell the switch is on, which is what makes the no-spec arm of the
  // on-arm test assertable against the pre-split golden.
  if (criteria === "") return fencedIssuePromptBlock(rawBody, rule, fencedIssueBody);
  return `\n\n${ISSUE_PROMPT_LEAD} ${ADVERSARIAL_FINDING_RULE}${CRITERIA_CLAUSE} ${rule}\n\n${prose}\n\n${criteria}`;
}

/**
 * The criteria argument for the adversarial seat, whose prompt is built inside the
 * loop. The loop takes the prose as `issueBody` and this as its own field, so the
 * switch is read once per gate call and an off arm threads nothing.
 */
export function reviewCriteriaSection(rawBody: string | undefined): {
  reviewCriteria?: string;
} {
  const criteria = leanReviewSpecSplitEnabled() ? renderSpecCriteriaSection(rawBody) : "";
  return criteria === "" ? {} : { reviewCriteria: criteria };
}

/**
 * The `issueBody` the adversarial seat is handed, for the loop to print as its
 * issue block. With a criteria section following it must be the STRIPPED prose —
 * the loop prints its own issue block from this value, so a raw body here puts
 * the whole `pi-spec v1` block in front of the reviewer a second time, JSON and
 * all, beside the section that already renders it.
 *
 * The `criteria !== ""` test is the same one `reviewCriteriaSection` applies, so
 * the two calls thread a pair or thread nothing: a body with no parsable block
 * keeps the raw bytes and the prompt stays today's. A body whose block parses,
 * strips and then renders no rows is the one case the pair is split over — it
 * cannot be, because `criteriaBlock` emits a line per criterion and the split
 * reaches here only when the parse that produced that list succeeded.
 *
 * NOT the same as `renderReviewProse`: that one bounds, and the loop applies its
 * own bound to what it prints. Stripping and re-bounding here would be the second
 * bound `MAX_ISSUE_CHARS` exists to forbid.
 */
export function seatIssueBody(rawBody: string | undefined): string | undefined {
  if (!leanReviewSpecSplitEnabled()) return rawBody;
  return renderSpecCriteriaSection(rawBody) === "" ? rawBody : stripPiSpecBlocks(rawBody ?? "");
}

/**
 * One call at each print site, so the switch is read in exactly one place: with
 * it off this is today's `fencedIssuePromptBlock(rawBody, rule, fencedIssueBody)`
 * — the parse, the strip and the criteria render never happen — and with it on it
 * is the split block above.
 */
export function reviewIssueBlock(rawBody: string | undefined, rule: string): string {
  return leanReviewSpecSplitEnabled()
    ? renderReviewIssueBlock(rawBody, rule)
    : fencedIssuePromptBlock(rawBody, rule, fencedIssueBody);
}
