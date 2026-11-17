/**
 * lean/review-posts — the two disclosures the review step owes the PR.
 *
 * `publish` ran before `review`, so the PR body cannot carry either; the forge
 * channel is the only place a reader sees them, and on
 * `PI_ENSEMBLE_HANDOFF_CHANNEL=host` the host owns every post and this posts nothing.
 *
 * **A failed post never changes the verdict.** The record and the warn line already
 * carry what the gate said. But a comment the forge refused is a disclosure a reader
 * cannot see, and a warn line nobody reads is the silent version of that — so the
 * names of what went missing come back to the caller, which rides them on the
 * outcome's reason (see `postFailureNote` in `review-pass.ts`), the same treatment
 * the lens layer gives its own failed residual post.
 *
 * **Two comments, not one**, in this order: the acceptance table says what the gate
 * said about each criterion; the bound record says what this step did NOT judge. Each
 * is attempted whatever arm closed the step, and the second is attempted even when
 * the first was refused — one lost post must not cost the run both disclosures.
 */

import { traceWarn } from "../trace.ts";
import { handoffChannel } from "../work-driver-handoff-channel.ts";
import { acceptanceComment } from "./review-acceptance.ts";
import type { ReviewDeps } from "./review-args.ts";
import { type ReviewBoundRecord, reviewBoundComment } from "./review-bound.ts";
import type { ContractSource } from "./state-derived-spec.ts";
import type { Step } from "./state.ts";

/** What the step posts, and what the forge refused. */
export interface ReviewPosts {
  /** The PR number `publish` recorded, or `undefined` when no comment can be posted. */
  readonly pr: number | undefined;
  /** The step's acceptance section, or `undefined` when it has none (the off arm, or an
   * unparsable spec): no section means no table comment, whatever the log holds. */
  readonly acceptanceTable: string | undefined;
  /** The bound record this attempt wrote, or `undefined` when every lane was judged and
   * there is nothing to disclose. */
  readonly bound: ReviewBoundRecord | undefined;
}

/**
 * Post both disclosures and report which the forge refused, as a bounded, `; `-joined
 * list of names (`"acceptance table"`, `"unreviewed-lanes disclosure …"`), or
 * `undefined` when every post landed — which is what keeps a clean run's reason
 * untouched. Never throws: a refused comment is not a review that found something.
 */
export async function postReviewDisclosures(
  deps: ReviewDeps,
  repoRoot: string,
  issue: number,
  steps: Step[],
  issueBody: string | undefined,
  head: string,
  posts: ReviewPosts,
  // Threaded so the comment tabulates the run's own contract (see `acceptanceComment`).
  run: ContractSource = {},
): Promise<string | undefined> {
  const forge = handoffChannel() !== "host";
  const post = forge && posts.pr !== undefined ? deps.prComment : undefined;
  if (post === undefined || posts.pr === undefined) return undefined;
  const pr = posts.pr;
  const acceptance =
    posts.acceptanceTable !== undefined ? acceptanceComment(steps, issueBody, head, run) : "";
  const owed: string[] = [];
  if (acceptance !== "")
    await post(repoRoot, pr, acceptance)
      .then(() => undefined)
      .catch((err: unknown) => {
        owed.push("acceptance table");
        traceWarn(
          `lean review #${String(issue)}: could not post the acceptance table: ${(err as Error)?.message ?? String(err)}`,
        );
      });
  if (posts.bound !== undefined) {
    const text = reviewBoundComment(posts.bound);
    await post(repoRoot, pr, text)
      .then(() => undefined)
      .catch((err: unknown) => {
        owed.push(`unreviewed-lanes disclosure ${text.slice(0, 40)}`);
        traceWarn(
          `lean review #${String(issue)}: could not post the unreviewed-lanes disclosure: ${(err as Error)?.message ?? String(err)}`,
        );
      });
  }
  return owed.length === 0 ? undefined : owed.join("; ");
}
