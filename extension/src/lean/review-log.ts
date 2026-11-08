/**
 * lean/review-log — the facts the `review` step reads out of the run's own step
 * log, and nothing else.
 *
 * All derivations from records OTHER steps wrote. All fail the same way: absent,
 * never guessed — each answer is "the step does not know", which every caller
 * treats as the fallback it is rather than as evidence.
 *
 * They are read from the log because of the resume: the engine re-runs exactly
 * the undecided `review` step, so anything needed across an attempt must be
 * recomputable from the durable record — a value in a closure is simply gone.
 */
import { OUTCOME_KINDS } from "./machine.ts";
import { isRunId } from "./state-dispatches.ts";
import { validPrUrl } from "./state-outcome.ts";
import type { Step } from "./state.ts";
import { newestDecided } from "./state.ts";
import type { FixRunId } from "./step-budget.ts";
import { FIXER_ROLE } from "./step-budget.ts";

/**
 * The epoch floor a fix tree's id must clear: below 1e12 (2001-09) a value is a
 * duration somebody measured, not a stamp naming a tree. Shared with the
 * validator's shape rule (`FIX_RUN_ID` in `state-dispatches.ts`) by the shape both
 * read — a second copy here would be a second answer to "is this a timestamp".
 */
export const FIX_EPOCH_FLOOR_MS = 1e12;

/**
 * The run id every fix tree of one attempt carries in its name.
 *
 * The id must be **reproducible within one attempt and disjoint between
 * concurrent ones**: reproducible so the step can name a tree it is about to
 * create (and so a resumed attempt re-enters the tree its crashed self left),
 * disjoint so a second cycle for the same issue cannot pick this one's path at
 * the same round. `now()` is the whole content, which is what makes it
 * recoverable — `fixRunIdFromLog` reads it back off the log.
 *
 * The digits-only form matters separately: the id is a validated field on the
 * fixer's dispatch row (`isRunId` in `state-dispatches.ts`) and the only way to
 * mint one is through here, so a value `Number()` would turn into `NaN` cannot
 * exist. It is a namespace, not a secret, and is not used as one.
 */
export function fixRunId(now: () => number): FixRunId {
  const ms = now();
  const value = Number.isSafeInteger(ms) && ms >= FIX_EPOCH_FLOOR_MS ? ms : Date.now();
  return String(value) as FixRunId;
}

/**
 * The run id of the fix trees this run has already made, or undefined.
 *
 * Read from the log because an id held in a closure would be re-minted by a
 * resumed attempt, leaving the killed attempt's tree under a name the new attempt
 * never prunes. The match keys on the row's own `runId` field, which **only a
 * fixer row has** — matching on role alone is not enough, since the builder
 * shares `FIXER_ROLE`.
 */
export function fixRunIdFromLog(steps: Step[]): FixRunId | undefined {
  for (const step of steps) {
    if (step.state !== REVIEW_STATE) continue;
    for (const row of step.outcome?.dispatches ?? []) {
      if (row.role !== FIXER_ROLE) continue;
      // The tree id is a composite — epoch plus per-visit counter — so it is read
      // back as the WHOLE field and checked with `isRunId`, the VALIDATOR'S OWN
      // predicate. A second grammar here would accept what the validator refuses,
      // and a resumed attempt could adopt a tree no writer ever minted. A row with
      // no usable id answers undefined and the step mints a fresh one: a new id
      // means a new tree, never a borrowed one.
      const id = row.runId;
      if (id !== undefined && isRunId(id)) return id;
    }
  }
  return undefined;
}

/**
 * The kinds a review pass ENDED with, as opposed to threw. An undecided entry
 * (no outcome) is the engine's replay marker and is skipped by every reader here.
 *
 * DERIVED from the machine's `review` entry rather than hand-listed: `test-lean-
 * machine.ts` asserts that entry equals the set of kinds the table gives `review`
 * arrows, so spreading it here is a fact about the table. A hand-written list
 * would go stale in the safe-looking direction — an added kind simply never
 * counted. The one kind a review record can carry that is NOT here is `error`,
 * which the engine writes when the handler threw and the registry refuses to any
 * handler.
 */
export const PASS_KINDS: readonly (typeof OUTCOME_KINDS.review)[number][] = [
  ...OUTCOME_KINDS.review,
];

/**
 * Did any review pass of THIS run integrate a fix, i.e. push commits to the run's
 * branch?
 *
 * `machine.ts` routes `review + fixed` to `verify` and `review + done` to `ci`, and
 * the difference is a fact about origin: `integrate` pushes the fixer's commits, so
 * the newest `verify` no longer describes the head. Under-report it and the run
 * walks into `ci` over a head its gate never read; over-report it and a clean run
 * pays for one redundant re-verification. That asymmetry is why this reads rows
 * rather than prose, and why the step asks the log when its own memory is gone —
 * a resumed attempt has lost its closure, but the push its crashed self made
 * stands on origin.
 *
 * **What the record proves.** A fixer row is appended on BOTH arms of a round —
 * the fixer that worked and the fixer that died — so a row is evidence the step
 * PAID for a round, not that anything landed. The claim that something landed is
 * the round's throw: every non-pushing path throws, and a throw is recorded as an
 * `error` outcome, so `error` entries are skipped.
 *
 * The state test is not decoration: the fixer's role is the BUILDER's role, so a
 * `build` step's rows would otherwise answer for a review fix the run never bought.
 */
export function fixedFromLog(steps: Step[]): boolean {
  return steps.some(
    (step) =>
      step.state === REVIEW_STATE &&
      step.outcome !== undefined &&
      // `Outcome.kind` is `string` by design, so the membership test widens the
      // needle rather than the list: `PASS_KINDS` keeps its registry-derived
      // element type and a renamed kind still fails this file to compile.
      PASS_KINDS.includes(step.outcome.kind as (typeof PASS_KINDS)[number]) &&
      step.outcome.dispatches?.some((row) => row.role === FIXER_ROLE) === true,
  );
}

/**
 * The tree identity a fixer row may carry: the epoch `fixRunId` mints, optionally
 * followed by the arm/round/attempt the tree is named for.
 *
 * A RE-EXPORT of the validator's own constant, not a second literal: this file
 * once kept its own permissive copy while the loader held the narrower, so every
 * test asserting against it agreed with the writer and none with the loader.
 */
export { FIX_RUN_ID as FIX_RUN_ID_SHAPE } from "./state-dispatches.ts";

/**
 * This attempt's number for the review step: the engine's own per-attempt counter
 * read off the log, not a value this step counts in memory.
 *
 * `fixTreeName` needs it to separate two concurrent attempts on one issue, and it
 * must come from the log for the same reason the epoch does: a counter in the
 * process restarts on resume, and a tree name that changes between an attempt and
 * its resume orphans the first attempt's tree. The count of review entries is
 * what the engine's `nextAttempt` derives its key from, so the two agree by
 * construction. A log with no review entry yet is attempt 0.
 */
export function reviewAttemptFromLog(steps: Step[]): number {
  let n = 0;
  // DECIDED entries only: the undecided tail is the engine's replay marker, and
  // counting it would advance the attempt on every re-run — including the re-runs
  // inside one pass, since the step's own write-ahead entry sits in the log its
  // handler reads. The step would then name a new tree per round and never re-enter
  // the tree its killed self left.
  for (const step of steps) if (step.state === REVIEW_STATE && step.outcome !== undefined) n++;
  return n;
}

/**
 * The PR number of this run's PR, derived from the URL `publish` recorded, or
 * undefined when no `publish` has decided — the same answer as "this run has no
 * PR to disclose findings to".
 *
 * Both forges this harness drives spell a PR's web URL with the number as a
 * trailing segment. The pattern is anchored at the end and both forms are named,
 * so a trailing path segment or an unrelated tail answers absent rather than
 * reporting whichever digits sat in the string. `new URL()` is deliberately not
 * used: a malformed value threw a `TypeError` out of the step, and "could not read
 * the PR number" is an answer the step already handles.
 *
 * Absent is safe because `runLensReview` falls back to asking the forge which PR
 * belongs to the branch — the very `gh pr list` per round this avoids.
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
 * The step's own budget sentence keys on the same name, so a second literal is a
 * second answer to "which state is this".
 */
export const REVIEW_STATE = "review";
