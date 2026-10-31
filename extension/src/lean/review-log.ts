/**
 * lean/review-log — the two facts the `review` step reads out of the run's own
 * step log, and nothing else.
 *
 * Both are derivations from records other steps wrote: `review.ts` decides which
 * verdict ends the loop and what a fixer is told, and neither of those questions
 * has anything to do with the tail of a PR URL or the shape of an epoch. Both
 * readers fail the same way: absent, never guessed. A run whose `publish` has not
 * decided has no PR; a run with no fixer row has no run id yet. Each answer is
 * "the step does not know", which every caller treats as the fallback it is,
 * rather than as a value that reads like evidence.
 */
import { validPrUrl } from "./state-outcome.ts";
import type { Step } from "./state.ts";
import { newestDecided } from "./state.ts";
import type { FixRunId } from "./step-budget.ts";
import { FIXER_ROLE } from "./step-budget.ts";

/**
 * The epoch floor a fix tree's id must clear, in milliseconds.
 *
 * 1e12 is 2001-09: below it a value is a duration somebody measured, not a stamp
 * that names a tree. One constant, shared with the validator's shape rule for the
 * field (`FIX_RUN_ID` in `state-dispatches.ts`) by the shape both read — a second
 * copy here would be a second answer to "is this a timestamp".
 */
export const FIX_EPOCH_FLOOR_MS = 1e12;

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
 * The digits-only form matters for a second reason: the id is a validated field
 * on the fixer's dispatch row (`runId`, checked by `isRunId` in
 * `state-dispatches.ts`), and the only way to mint one is through here — so a value
 * `Number()` would turn into `NaN` cannot exist. It is a namespace, not a secret,
 * and is not used as one.
 */
export function fixRunId(now: () => number): FixRunId {
  const ms = now();
  const value = Number.isSafeInteger(ms) && ms >= FIX_EPOCH_FLOOR_MS ? ms : Date.now();
  return String(value) as FixRunId;
}

/**
 * The run id of the fix trees this run has already made, or undefined.
 *
 * Read from the step log because the log is what a resume trusts: the engine
 * re-runs exactly the undecided `review` step, and an id held in a closure would
 * be re-minted by the resumed attempt — so the killed attempt's tree would sit
 * under a name the new attempt never prunes, and its round could not be told
 * apart from a fresh one. Reusing the id re-enters the same paths.
 *
 * The match keys on the row's own `runId` field, which **only a fixer row has**:
 * the previous reader matched on `role === "developer"`, and that is the builder's
 * role too, so a `build` step's row could answer for a fix tree the review step
 * never made. A row with no `runId` — including every row the validator refused —
 * answers undefined and the step mints a fresh id, which is the safe direction: a
 * new id means a new tree, never a borrowed one.
 */
export function fixRunIdFromLog(steps: Step[]): FixRunId | undefined {
  for (const step of steps) {
    if (step.state !== REVIEW_STATE) continue;
    for (const row of step.outcome?.dispatches ?? []) {
      if (row.role !== FIXER_ROLE) continue;
      // The tree id is a composite — the attempt's epoch plus the per-visit
      // counter — so it is read back as the WHOLE field, not as an integer. The
      // `FIX_RUN_ID` shape every fixer row carries is already checked by the
      // validator on the way in (`state-dispatches.ts`), and re-checking it with
      // `Number()` here would reject the composite and silently re-mint an id,
      // which strands the tree a crashed attempt left under a name this attempt
      // never prunes.
      const id = row.runId;
      if (
        id !== undefined &&
        Number.isSafeInteger(Number(id.slice(0, 17).split("-")[0])) &&
        Number(id.split("-")[0]) >= FIX_EPOCH_FLOOR_MS
      )
        return id as FixRunId;
    }
  }
  return undefined;
}

/**
 * The tree identity a fixer row may carry: the epoch `fixRunId` mints, optionally
 * followed by the arm/round/attempt the tree is named for.
 *
 * A RE-EXPORT of the validator's own constant, not a second literal. This file
 * used to carry its own permissive literal while `state-dispatches.ts` carried a
 * digits-only one, and the loader — the one that decides whether a row survives —
 * held the narrower. Every test that claimed to protect the field asserted against
 * THIS constant, so all three agreed with the writer and none agreed with the
 * loader: the fixer's row was dropped from the cost record and the tests stayed
 * green. Importing the rule from its owner makes the drift impossible rather than
 * documented.
 */
export { FIX_RUN_ID as FIX_RUN_ID_SHAPE } from "./state-dispatches.ts";

/**
 * This attempt's number for the review step: the engine's own per-attempt counter
 * read off the log, not a value this step counts in memory.
 *
 * `fixTreeName` needs it to separate two concurrent attempts on one issue, and it
 * has to come from the log for the same reason the epoch does: a counter in the
 * process restarts when the engine re-runs the undecided step, and a tree name
 * that changes between an attempt and its resume orphans the first attempt's tree
 * and provisions a second. The count of review entries is what the engine's
 * `nextAttempt` derives the key it is about to write from, so the two agree by
 * construction. A log with no review entry yet is attempt 0.
 */
export function reviewAttemptFromLog(steps: Step[]): number {
  let n = 0;
  // DECIDED entries only. The undecided tail is the engine's replay marker, and
  // counting it would advance the attempt on every re-run — including the re-runs
  // inside one pass, since the step's own write-ahead entry sits in the log its
  // handler reads. The step would then name a new tree per round, mint a new
  // epoch off it, and never re-enter the tree its killed self left: the exact
  // property this name exists to give, and measured as a loop that never reaches
  // its round bound because each round was a fresh attempt.
  for (const step of steps) if (step.state === REVIEW_STATE && step.outcome !== undefined) n++;
  return n;
}

/**
 * The PR number of this run's PR, derived from the URL `publish` recorded, or
 * undefined when no `publish` has decided — which is the same answer as "this
 * run has no PR to disclose findings to".
 *
 * The log holds the URL and nothing else (`prUrl` is publish-only by contract),
 * and both forges this harness drives spell a PR's web URL with the number as a
 * trailing segment: GitHub `/pull/<n>`, GitLab `/-/merge_requests/<n>`. The
 * pattern is anchored at the end and the two forms are named, so a URL with a
 * trailing path segment (`…/pull/321/files`) or an unrelated tail answers absent
 * rather than reporting whatever digits happened to sit somewhere in the string.
 * `new URL()` is deliberately not used: a malformed value threw a `TypeError` out
 * of the step, and "I could not read the PR number" is an answer the step already
 * has a path for.
 *
 * Absent is not a gap this step papers over: `runLensReview` falls back to asking
 * the forge which PR belongs to the branch, which is exactly the `gh pr list` per
 * ISSUES_FOUND round that this derivation exists to avoid — and that fallback is
 * the reason absent is a safe answer rather than a refusal.
 */
const PR_URL_TAIL = /(?:^|\/)(?:pull|merge_requests)\/(\d+)\/?$/;

export function prNumberFromLog(steps: Step[]): number | undefined {
  const url = validPrUrl(newestDecided(steps, "publish")?.outcome?.prUrl);
  if (url === undefined) return undefined;
  const tail = PR_URL_TAIL.exec(url)?.[1];
  if (tail === undefined) return undefined;
  const n = Number(tail);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The state whose handler these readers serve; a constant, not a parameter. */
const REVIEW_STATE = "review";
