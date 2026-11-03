/**
 * lean/review-log — the facts the `review` step reads out of the run's own step
 * log, and nothing else.
 *
 * All derivations from records OTHER steps wrote: `review.ts` decides which verdict
 * ends the loop and what a fixer is told, and none of those questions has anything
 * to do with the tail of a PR URL, the shape of an epoch, or whether a fix round
 * moved a branch. All fail the same way: absent, never guessed. A run whose
 * `publish` has not decided has no PR; a run with no fixer row has no tree id yet;
 * a run with no decided review pass fixed nothing. Each answer is "the step does
 * not know", which every caller treats as the fallback it is rather than as a
 * value that reads like evidence.
 *
 * The reason they are read from the log at all is the resume. The engine re-runs
 * exactly the undecided `review` step, so anything the step needs across an attempt
 * must be recomputable from the durable record — a value in a closure is simply
 * gone, and these readers are the only way a resumed attempt gets back the tree it
 * left, the PR it is disclosing to, and the verdict its own finished passes earned.
 */
import { OUTCOME_KINDS } from "./machine.ts";
import { isRunId } from "./state-dispatches.ts";
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
      // counter — so it is read back as the WHOLE field, not as an integer, and it
      // is checked against `isRunId`, the VALIDATOR'S OWN predicate rather than a
      // second grammar this file kept. The reader used to run
      // `Number.isSafeInteger(Number(id.slice(0, 17).split("-")[0]))` plus a floor
      // check of its own, which ACCEPTED what the validator refuses — `"1e12"`, a
      // leading sign, a fraction — so the claim that the validator had already
      // checked the field was false, and a resumed attempt could adopt a tree no
      // writer ever minted. Asking the module that owns the grammar makes the claim
      // true by construction rather than by assertion. A row with no `runId` —
      // including every row the validator refused — answers undefined and the step
      // mints a fresh id, which is the safe direction: a new id means a new tree,
      // never a borrowed one.
      const id = row.runId;
      if (id !== undefined && isRunId(id)) return id;
    }
  }
  return undefined;
}

/**
 * The kinds a review pass ENDED with, as opposed to threw. An undecided entry
 * (no outcome) is the engine's replay marker and is skipped by every reader in
 * this file.
 *
 * Exported for the same reason `FIX_RUN_ID_SHAPE` is: the loader and the smoke
 * fixtures both need the set of kinds a pass may carry, and a second literal they
 * drift apart is how a fixture starts asserting against a shape no writer emits.
 *
 * Typed against the registry itself rather than `string[]`, and DERIVED from it:
 * the machine's `review` entry is the authority on which kinds `review` may end
 * with, and `test-lean-machine.ts` asserts that entry equals the set of kinds the
 * table gives `review` arrows — which is what makes spreading it here a fact about
 * the table and not an assumption. A hand-written list would be a second answer to
 * "which kinds are a pass", and would go stale in the safe-looking direction: a
 * kind added to the table simply never counted, and the run stopped re-verifying
 * its own fix commits.
 *
 * The one kind a review step record can carry that is NOT here is `error`, which
 * the engine writes when the handler threw ({@link fixedFromLog} skips it) and
 * which the registry refuses to any handler.
 */
export const PASS_KINDS: readonly (typeof OUTCOME_KINDS.review)[number][] = [
  ...OUTCOME_KINDS.review,
];

/**
 * Did any review pass of THIS run integrate a fix, i.e. push commits to the run's
 * branch? The fallback the step's own loop count cannot serve: a resumed attempt
 * has lost its closure, and the push its crashed self made stands on origin.
 *
 * `machine.ts` routes `review + fixed` to `verify` and `review + done` to `ci`,
 * and the difference is a fact about origin — `integrate` in `review-git.ts`
 * pushes the fixer's commits, so the newest `verify` no longer describes the head
 * and `ci` refuses that twice over. Under-report it and the run walks into `ci`
 * over a head its gate never read; over-report it and a clean run pays for one
 * redundant re-verification. That asymmetry is why this reads rows rather than
 * prose, and why the step asks the log when its own memory is gone.
 *
 * **What the record proves, and what it does not.** A fixer row is appended by
 * `runFixer` on BOTH arms of a round — the fixer that worked and the fixer that
 * died — so a row is evidence the step PAID for a round, not that anything landed.
 * The claim that something landed is the round's throw: `integrate` calls `fail()`
 * and `assertFixAdvanced` throws on every path that did not push, and the engine
 * records a throw as an `error` outcome. So `error` entries are skipped and only
 * the two kinds a pass ends with are counted.
 *
 * The state test is not decoration: the fixer's role is the BUILDER's role
 * (`FIXER_ROLE`), so a `build` step's rows — the CI fix round's — would otherwise
 * answer for a review fix the run never bought, and every run that fixed its CI
 * would re-verify a head its review never moved.
 */
export function fixedFromLog(steps: Step[]): boolean {
  return steps.some(
    (step) =>
      step.state === REVIEW_STATE &&
      step.outcome !== undefined &&
      // `Outcome.kind` is `string` by design (the loader accepts any kind a
      // handler may return), so the membership test widens the needle rather than
      // the list: `PASS_KINDS` keeps its registry-derived element type and a
      // renamed kind in the table still fails this file to compile.
      PASS_KINDS.includes(step.outcome.kind as (typeof PASS_KINDS)[number]) &&
      step.outcome.dispatches?.some((row) => row.role === FIXER_ROLE) === true,
  );
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

/**
 * The state whose handler these readers serve; a constant, not a parameter.
 *
 * Exported because the step's own budget sentence keys on the same name: a
 * second literal is a second answer to "which state is this", and the two
 * drift apart exactly when a cause line stops matching the log it describes.
 */
export const REVIEW_STATE = "review";
