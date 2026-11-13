/**
 * adversarial-criteria-seat — the criteria section both halves of the loop are
 * given, from whoever rendered it.
 *
 * The loop can render the section itself, but it can only render it from
 * `params.issueBody`. Lean's review seat passes that field the issue's prose with
 * its `pi-spec v1` block STRIPPED — the block the seat already prints as a
 * rendered criteria section — so a loop that re-derives from it parses a body with
 * no block in it and hands both its reviewer and its fixer no criteria at all. The
 * two call sites in `adversarial.ts` are the whole of the loop's criteria wiring,
 * and both take the same decision, stated once here:
 *
 *   - a caller that SUPPLIED a section gets it back unchanged. It is never
 *     re-rendered: `reviewCriteriaSection` takes a RAW body, and a rendered section
 *     has no block left to parse, so re-rendering one returns nothing;
 *   - a caller that supplied nothing derives one from the body it passed, exactly
 *     as before this file existed. The /work driver and the `adversarial_loop` tool
 *     are that caller, and their prompts are unchanged by it.
 *
 * The key test is `"reviewCriteria" in params`, not `!== undefined`: a caller that
 * decided "no section for this body" may thread an empty one, and re-deriving over
 * that would put the machine block back in front of a seat that asked for prose.
 */
import type { AdversarialLoopParams } from "./adversarial-loop-params.ts";
import { reviewCriteriaSection } from "./lean/review-spec-split.ts";

/** The criteria argument for one of the loop's two prompt builders. */
export function criteriaForSeat(params: AdversarialLoopParams): { reviewCriteria?: string } {
  return "reviewCriteria" in params
    ? { reviewCriteria: params.reviewCriteria }
    : reviewCriteriaSection(params.issueBody);
}
