/**
 * lean/review-log — the facts the `review` step reads out of the run's own step
 * log, and nothing else.
 *
 * All derivations from records OTHER steps wrote, all failing the same way: absent, never guessed. Each answer
 * is "the step does not know", which callers treat as the fallback it is, not as evidence.
 *
 * Read from the log because of the resume: the engine re-runs exactly the undecided `review` step, so anything
 * needed across an attempt must be recomputable from the durable record.
 */
import { OUTCOME_KINDS } from "./machine.ts";
import { isRunId } from "./state-dispatches.ts";
import { validPrUrl } from "./state-outcome.ts";
import type { Step } from "./state.ts";
import { newestDecided } from "./state.ts";
import type { FixRunId } from "./step-budget.ts";
import { FIXER_ROLE } from "./step-budget.ts";

/**
 * The epoch floor a fix tree's id must clear: below 1e12 a value is a duration somebody measured, not a
 * stamp naming a tree. Shared with the validator's `FIX_RUN_ID` shape rule in `state-dispatches.ts`.
 */
const FIX_EPOCH_FLOOR_MS = 1e12;

/**
 * The run id every fix tree of one attempt carries in its name.
 *
 * It must be **reproducible within one attempt and disjoint between concurrent ones**: reproducible so a
 * resumed attempt re-enters the tree its crashed self left, disjoint so a second cycle for the same issue
 * cannot pick this one's path. `now()` is the whole content, which makes it recoverable.
 *
 * The digits-only form matters separately: the id is a validated field on the fixer's dispatch row, and this
 * is the only way to mint one.
 */
export function fixRunId(now: () => number): FixRunId {
  const ms = now();
  const value = Number.isSafeInteger(ms) && ms >= FIX_EPOCH_FLOOR_MS ? ms : Date.now();
  return String(value) as FixRunId;
}

/**
 * The run id of the fix trees this run has already made, or undefined.
 *
 * Read from the log because an id in a closure would be re-minted by a resumed attempt, leaving the killed
 * attempt's tree under a name the new one never prunes. Matching keys on the row's own `runId`, which **only
 * a fixer row has** — role alone is not enough, since the builder shares `FIXER_ROLE`.
 */
export function fixRunIdFromLog(steps: Step[]): FixRunId | undefined {
  for (const step of steps) {
    if (step.state !== REVIEW_STATE) continue;
    for (const row of step.outcome?.dispatches ?? []) {
      if (row.role !== FIXER_ROLE) continue;
      // Read as the WHOLE field and checked with `isRunId`, the validator's own predicate — a second grammar
      // here could accept what the validator refuses. No usable id answers undefined and the step mints a
      // fresh one: a new id means a new tree.
      const id = row.runId;
      if (id !== undefined && isRunId(id)) return id;
    }
  }
  return undefined;
}

/**
 * The kinds a review pass ENDED with, as opposed to threw. An undecided entry is the engine's replay
 * marker and is skipped by every reader here.
 *
 * DERIVED from the machine's `review` entry rather than hand-listed: a hand-written list would go stale in
 * the safe-looking direction — an added kind simply never counted. The one kind not here is `error`.
 */
export const PASS_KINDS: readonly (typeof OUTCOME_KINDS.review)[number][] = [
  ...OUTCOME_KINDS.review,
];

/**
 * Did any review pass of THIS run integrate a fix, i.e. push commits to the run's branch?
 *
 * `machine.ts` routes `review + fixed` to `verify` and `review + done` to `ci`, and the difference is a fact
 * about origin: `integrate` pushes the fixer's commits, so the newest `verify` no longer describes the head.
 * Under-report and the run walks into `ci` over a head its gate never read; over-report and a clean run pays
 * for a redundant re-verification. That asymmetry is why this reads rows not prose, and why the step asks the
 * log when its own memory is gone — a resumed attempt lost its closure, but its crashed self's push stands.
 *
 * **What the record proves.** A fixer row is appended on BOTH arms of a round — the fixer that worked and the
 * one that died — so a row evidences that the step PAID for a round, not that anything landed. That claim is
 * the round's throw: every non-pushing path throws, and a throw records as `error`, so `error` entries skip.
 *
 * The state test is not decoration: the fixer's role is the BUILDER's, so a `build` step's rows would otherwise
 * answer for a review fix the run never bought.
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
 * The tree identity a fixer row may carry — a RE-EXPORT of the validator's own constant, not a second literal.
 */
export { FIX_RUN_ID as FIX_RUN_ID_SHAPE } from "./state-dispatches.ts";

/**
 * This attempt's number for the review step: the engine's per-attempt counter, read off the log.
 *
 * `fixTreeName` needs it to separate concurrent attempts, and it comes from the log for the epoch's reason: a
 * counter in the process restarts on resume and orphans the first attempt's tree. The count of review entries
 * is what `nextAttempt` derives its key from, so the two agree by construction.
 */
export function reviewAttemptFromLog(steps: Step[]): number {
  let n = 0;
  // DECIDED entries only: counting the undecided tail advances the attempt on every re-run, including those
  // inside one pass.
  for (const step of steps) if (step.state === REVIEW_STATE && step.outcome !== undefined) n++;
  return n;
}

/**
 * The PR number from the URL `publish` recorded, or undefined when no `publish` has decided — the same answer
 * as "this run has no PR to disclose findings to".
 *
 * Both forges spell the number as a trailing segment. The pattern is anchored with both forms named, so a
 * trailing path answers absent. `new URL()` is not used: a malformed value threw a `TypeError` out of the step.
 *
 * Absent is safe — `runLensReview` falls back to asking the forge which PR belongs to the branch.
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
 */
export const REVIEW_STATE = "review";
