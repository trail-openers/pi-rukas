/**
 * lens-review-memory — the findings-memory half of one lens review
 * (#1105, #1125), split from lens-review.ts (the 500-line gate).
 *
 * Two reads and one write, and the rule that ties them together: the round's
 * evidence must come from the SAME store it records to.
 *
 *   - `priorFindingsFor` — the branch's open and accepted findings as a fenced
 *     DATA block for every lens prompt (empty on a first review). Fail-OPEN: a
 *     prompt missing its prior-findings data costs nothing and must never fail
 *     a review.
 *   - `recordRound` — the round against the findings memory: suppressed findings
 *     leave the review, and a complete full review resolves rows it no longer
 *     reports. A delta round carries its own diff so the store can derive the
 *     changed line ranges (#1125 decision 5).
 *   - `memoryDisclosure` — what the summary says about memory: the reason a
 *     round that could NOT record must be visibly different from a round that
 *     consulted an empty store, plus the set-asides the round had already
 *     disclosed before the write decided the outcome (those ride on the refusal
 *     too, because a refusal still reaches the summary and the residual
 *     comment).
 *
 * Nothing here decides a verdict; `runLensReview` owns that.
 */

import { renderPriorFindingsBlock } from "./lens-residuals.ts";
import type { Finding } from "./lens-review-types.ts";
import type { ReviewKind } from "./review-findings-fate.ts";
import type { SetAsideNotice } from "./review-findings-file.ts";
import { readBranchRows, recordFindingRunOutcome } from "./review-findings-store.ts";

/** The memory side of a finished round, ready for the summary's spread. */
export interface MemoryDisclosure {
  memoryNote?: string;
  setAside?: SetAsideNotice[];
}

/** The prior-findings block for the lens prompts ("" when there is no memory to show). */
export async function priorFindingsFor(
  cwd: string,
  branch: string | undefined,
  headSha: string | undefined,
): Promise<string> {
  if (!branch || !headSha) return "";
  return renderPriorFindingsBlock(await readBranchRows(cwd, branch));
}

/** Record one round; `undefined` when the review has no branch/head to key on. */
export function recordRound(opts: {
  cwd: string;
  branch: string | undefined;
  headSha: string | undefined;
  findings: Finding[];
  review: ReviewKind;
  /** The delta diff, given only for a delta round (the ranges derive from it). */
  deltaDiff?: string;
}) {
  if (!opts.branch || !opts.headSha) return Promise.resolve(undefined);
  return recordFindingRunOutcome({
    cwd: opts.cwd,
    branch: opts.branch,
    headSha: opts.headSha,
    findings: opts.findings,
    review: opts.review,
    ...(opts.deltaDiff !== undefined ? { deltaDiff: opts.deltaDiff } : {}),
  });
}

/**
 * The summary's memory fields. `recorded` undefined means the round did not
 * consult memory at all (no branch/head) — the summary stays silent, which is
 * honest. A `{ok:false}` outcome says WHY memory was unavailable, and still
 * carries any set-aside the round had already earned before it failed.
 */
export function memoryDisclosure(
  recorded: Awaited<ReturnType<typeof recordFindingRunOutcome>> | undefined,
): MemoryDisclosure {
  const note =
    recorded && !recorded.ok ? `findings memory unavailable: ${recorded.reason}` : undefined;
  const setAside = recorded?.setAside;
  return {
    ...(note ? { memoryNote: note } : {}),
    ...(setAside && setAside.length > 0 ? { setAside } : {}),
  };
}
