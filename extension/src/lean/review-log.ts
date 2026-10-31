/**
 * lean/review-log — the two facts the `review` step reads out of the run's own
 * step log, and nothing else.
 *
 * Both are derivations from records other steps wrote, which is why they live
 * apart from the decision procedure rather than inside it: `review.ts` decides
 * which verdict ends the loop and what a fixer is told, and neither of those
 * questions has anything to do with the tail of a PR URL or the shape of a
 * base36 run id. Split out along the seam `publish-deps.ts` and `review-deps.ts`
 * already use — judgement in one file, the reading of a record in another — and
 * small enough that the step's two halves stay inside the size limit each is
 * supposed to be held to.
 *
 * Both readers fail the same way: absent, never guessed. A run whose `publish`
 * has not decided has no PR; a run with no fixer row has no run id yet. Each
 * answer is "the step does not know", which every caller treats as the fallback
 * it is, rather than as a value that reads like evidence.
 */

import { validPrUrl } from "./state-outcome.ts";
import type { Step } from "./state.ts";
import { newestDecided } from "./state.ts";

/**
 * The run id every fix tree of one attempt carries in its name.
 *
 * A fixed path per (issue, round) was the defect this id exists to close: with a
 * shared name, `worktree add` was the only thing that could refuse a non-empty
 * directory, and two awaits sat between it and the read that says the tree is
 * clean. The id has to be **reproducible within one attempt and disjoint between
 * concurrent ones** — reproducible so the step can name a tree it is about to
 * create (and so a test can name the tree it must pre-populate to drive the
 * collision path), disjoint so a second cycle for the same issue cannot pick this
 * one's path at the same round.
 *
 * `now()` is the whole content, which also makes a resumed attempt land back on
 * the tree the crashed one left — the property `fixRunIdFromLog` reads back off
 * the log. The seconds-then-random shape `makeRunId()` produces would have been
 * disjoint but not recoverable, and recoverability is the half a resume needs.
 * The number form matters for a second reason: the id rides home in a dispatch
 * row's `ms` slot, which the outcome validator requires to be a finite
 * non-negative number (`isMeasure` in `state-outcome.ts`), and a base36 string
 * smuggled through a number field is the shape a validator cannot check. It is a
 * namespace, not a secret, and is not used as one.
 */
export function fixRunId(now: () => number): string {
  const ms = now();
  return Number.isSafeInteger(ms) && ms >= 0 ? String(ms) : String(Math.floor(Date.now()));
}

/**
 * The role name `runFixer` in `review-git.ts` stamps on its row. Spelled here
 * rather than imported because that module imports this one's `ReviewDeps` and
 * `review.ts`, so a value import back would be a cycle read before
 * initialisation; `test-lean-review-wiring.ts` pins the string against the row
 * the fixer actually produces, so the two cannot drift apart silently.
 */
const FIXER_ROLE = "developer";

/** The state whose handler these readers serve; a constant, not a parameter. */
const REVIEW_STATE = "review";

/**
 * The run id of the fix trees this run has already made, or undefined.
 *
 * Read from the step log because the log is what a resume trusts: the engine
 * re-runs exactly the undecided `review` step, and an id held in a closure would
 * be re-minted by the resumed attempt — so the killed attempt's tree would sit
 * under a name the new attempt never prunes, and its round could not be told
 * apart from a fresh one. Reusing the id re-enters the same paths.
 *
 * The fixer's row carries it, because `fixRound` is the only caller of
 * `fixTreeName` and `runFixer` stamps the row it bills with the id of the tree
 * its child worked in (in `ms`, which `fixRunId` guarantees is a plain integer).
 * A row whose `ms` is not a plausible timestamp — a child that reported no
 * duration, or a row some other writer produced — answers undefined and the step
 * mints a fresh id, which is the safe direction: a new id means a new tree, never
 * a borrowed one.
 */
export function fixRunIdFromLog(steps: Step[]): string | undefined {
  for (const step of steps) {
    if (step.state !== REVIEW_STATE) continue;
    for (const row of step.outcome?.dispatches ?? []) {
      if (row.role !== FIXER_ROLE) continue;
      // 1e12 ms is 2001-09, so anything below it is a duration and not a stamp.
      if (Number.isSafeInteger(row.ms) && row.ms >= 1e12) return String(row.ms);
    }
  }
  return undefined;
}

/**
 * The PR number of this run's PR, derived from the URL `publish` recorded, or
 * undefined when no `publish` has decided — which is the same answer as "this
 * run has no PR to disclose findings to".
 *
 * The log holds the URL and nothing else (`prUrl` is publish-only by contract),
 * and both forges spell a PR's web URL with the number as its last path segment
 * (`/pull/<n>`, `/merge_requests/<n>`). Absent is not a gap this step papers
 * over: `runLensReview` falls back to asking the forge which PR belongs to the
 * branch, which is exactly the `gh pr list` per ISSUES_FOUND round that this
 * derivation exists to avoid — and that fallback is the reason absent is a safe
 * answer rather than a refusal.
 */
export function prNumberFromLog(steps: Step[]): number | undefined {
  const url = validPrUrl(newestDecided(steps, "publish")?.outcome?.prUrl);
  if (url === undefined) return undefined;
  const last = new URL(url).pathname
    .split("/")
    .filter((s) => s !== "")
    .pop();
  if (last === undefined || !/^\d+$/.test(last)) return undefined;
  const n = Number(last);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}
