/**
 * lean/review-acceptance-step — the three things the `review` step does with the
 * executed acceptance table, at the three points of its life where each belongs.
 *
 * `review-acceptance.ts` renders the table and owns the guard's rule; this module
 * owns WHERE the step asks. Those are different questions and they change for
 * different reasons: the renderer changes when a cell's wording changes, this file
 * changes when the step's control flow does. Keeping them apart is also what keeps
 * `review.ts` a decision procedure rather than a file that additionally knows how
 * to post a comment.
 *
 * The three points, and why each sits where it does:
 *
 *   1. **Compose** (`composeAcceptanceTable`) — before any child is paid. The table
 *      is composed ONCE per step from the run's own step log (A1: read, never
 *      re-executed) and handed to both passes of both gates and to the PR comment,
 *      so six lens briefs, one adversarial brief per pass and one comment all carry
 *      the SAME bytes. Two renderings would be two tables.
 *   2. **Guard** (`guardAcceptanceHead`) — after the head is read, before pass 1 is
 *      bought. `publish` already refused to open a PR over any head but the newest
 *      green `verify`'s, so a difference here means someone pushed between that step
 *      and this one, and every `pass at <head>` cell would then speak about a commit
 *      nobody ran. One git read, asked at the cheapest possible point.
 *   3. **Post** (`postAcceptanceComment`) — in the step's `finally`. A table of
 *      results at the head is a disclosure rather than a verdict, so an arm that
 *      threw still owes the reader what the gate said. It is a SEPARATE comment from
 *      the bound stop's unreviewed-lanes post: that one answers what this step did
 *      NOT judge, this one answers what the gate said about each criterion, and
 *      collapsing them would let a missing-lane disclosure ride on a table that
 *      posted.
 *
 * All three are no-ops when `PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE=0`: the off arm
 * pays no read, composes nothing, posts nothing, and every brief is the render from
 * before the table existed.
 */

import { traceWarn } from "../trace.ts";
import { handoffChannel } from "../work-driver-handoff-channel.ts";
import { leanReviewAcceptanceEnabled } from "./review-acceptance-switch.ts";
import {
  acceptanceComment,
  assertHeadIsVerified,
  renderAcceptanceSection,
} from "./review-acceptance.ts";
import type { ReviewDeps } from "./review-args.ts";
import type { Step } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/** The table the step threads into every seat, or `undefined` when it has none.
 * `undefined` (and not `""`) at the seams is what makes the off arm byte-identical:
 * the brief builders print nothing for it, exactly as they did before this feature. */
export type AcceptanceTable = string | undefined;

/**
 * Compose the step's one table, or `undefined` when there is nothing to say.
 *
 * `undefined` on both the off arm and on an issue whose spec cannot be parsed —
 * the same refusal `review-criteria.ts` applies to its own section. Read once, at
 * the top of the step, beside the config and the issue read: a seat that saw the
 * table and a seat that did not must never depend on when it was asked.
 */
export function composeAcceptanceTable(
  steps: Step[],
  issueBody: string | undefined,
): AcceptanceTable {
  if (!leanReviewAcceptanceEnabled()) return undefined;
  const section = renderAcceptanceSection(steps, issueBody);
  return section === "" ? undefined : section;
}

/**
 * Refuse a head the gate never certified, unless the feature is off.
 *
 * The caller passes the head it resolved for the gates; the guard re-reads origin
 * rather than trusting it, because the guard's whole subject is whether origin
 * still holds the certified commit. Skipped ENTIRELY when the table is absent —
 * the off arm pays no git read, so the pre-feature path stays byte for byte.
 */
export async function guardAcceptanceHead(
  deps: ReviewDeps,
  steps: Step[],
  repoRoot: string,
  branch: string,
  head: string,
  rows: DispatchUsageRow[],
  table: AcceptanceTable,
): Promise<void> {
  if (table === undefined) return;
  await assertHeadIsVerified(deps, steps, repoRoot, branch, head, rows);
}

/**
 * Post the table on the run's PR, once per attempt, and never change a verdict.
 *
 * Forge channel only, and only when the run has a PR and the step has a forge
 * channel to post on: `publish` wrote the PR body before this step ran, so the body
 * cannot carry what this step composed, and on `PI_ENSEMBLE_HANDOFF_CHANNEL=host`
 * the host owns every post. A failed post is a warn line, never a thrown error —
 * the verdict was already decided by the gates, and a disclosure that could not
 * reach the reader is that reader's loss, not a reason to fail the run.
 */
export async function postAcceptanceComment(
  deps: ReviewDeps,
  steps: Step[],
  issue: number,
  repoRoot: string,
  pr: number | undefined,
  issueBody: string | undefined,
  reviewedHead: string,
  table: AcceptanceTable,
): Promise<void> {
  if (
    table === undefined ||
    handoffChannel() === "host" ||
    pr === undefined ||
    deps.prComment === undefined
  )
    return;
  const comment = acceptanceComment(steps, issueBody, reviewedHead);
  if (comment === "") return;
  await deps
    .prComment(repoRoot, pr, comment)
    .catch((err: unknown) =>
      traceWarn(
        `lean review #${String(issue)}: could not post the acceptance table: ${(err as Error)?.message ?? String(err)}`,
      ),
    );
}
