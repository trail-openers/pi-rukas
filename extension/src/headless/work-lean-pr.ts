/**
 * headless/work-lean-pr — the PR-side readings of a lean run's record: whether it opened
 * a PR, what head that PR stands on, and whether the run's own gate cleared that exact
 * head.
 *
 * Split from `work-lean-result.ts` along the seam the fields already had: the status and
 * failure readers ask what the run DID, these ask what the run SHIPPED and who certified
 * it. They are also the readers `headless/work-lean-gates.ts` borrows rather than
 * restating — the two head fields on `gates.handback` and `prState` are one answer read
 * through these functions, which is the only reason two surfaces cannot tell two stories
 * about the same commit. `reviewCompleteOf` sits here for the same reason: it is the same
 * head question read from the other side — not "did the gate certify what shipped" but "did
 * a LENS read what stands on the PR" — and its answer is a step's position relative to
 * `publish`, a fact this module already owns.
 *
 * The load-bearing rule is in `gateClearedPublishedHead`: a green is worth nothing unless
 * it is about the head that shipped, and a newest step with no outcome is a crash, not a
 * verdict. Wherever evidence is missing the answer is `draft`, the safe side — a host
 * told `ready` merges, a host told `draft` goes and looks.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { OutcomeKind } from "../lean/machine.ts";
import { validPrUrl } from "../lean/state-outcome.ts";
import type { Step } from "../lean/state.ts";
import { newestDecided } from "../lean/state.ts";
import type { IssueResult } from "./result.ts";

/**
 * The newest DECIDED `publish` step's URL, if the run got that far.
 *
 * `newestDecided` is the log's own rule (an outcome-less step is a crash
 * mid-step and has said nothing), so a newer `publish` that decided without a
 * URL reports no URL — reading one from an earlier publish would hand the host
 * the address of a PR this run replaced. The value is then re-checked with the
 * load-time rule `handback` applies rather than trusted: the log this projection
 * reads is a `Step[]`, and the loader is not the only thing that hands one over.
 * A URL that breaks the shape is not a link a host should open, and it is not a
 * PR either — which is why `prState` asks THIS function, not the raw field.
 */
export function prUrlOf(steps: Step[]): string | undefined {
  return validPrUrl(newestDecided(steps, "publish")?.outcome?.prUrl);
}

/**
 * The full head the publish step says it shipped: its typed `publishedHead`,
 * re-checked with the SAME shape rule the loader enforces — the loader is not the
 * only thing that hands a `Step[]` over (an in-memory log from a run that just
 * finished never passed through it), exactly as `prUrlOf` revalidates the URL.
 * A publish that recorded no head, or one that is not an oid, returns
 * `undefined`, and that is what makes `prState` refuse `ready`. The reason line's
 * `at <sha>` is NOT read: prose is what this field exists to replace.
 */
export function publishedHeadOf(publish: Step | undefined): string | undefined {
  const head = publish?.outcome?.publishedHead;
  return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
}

/**
 * The newest step in the WHOLE log whose `state` matches, decided or not. Log
 * POSITION is what makes a verdict the run's current one — `newestDecided` would
 * skip an outcome-less step and let an older verdict speak for a gate that died.
 */
export function newestAttempt(steps: Step[], state: Step["state"]): Step | undefined {
  const at = lastAttempt(steps, state);
  return at < 0 ? undefined : steps[at];
}

/** The same reading as a POSITION, which is what a question about ORDER needs, and -1 when
 * the log holds no such step. Decided or not: a step that started and died is a step that
 * happened, and a `publish` that died mid-push is exactly the case an answer must not gloss
 * over. */
function lastAttempt(steps: Step[], state: Step["state"]): number {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i]?.state === state) return i;
  return -1;
}

/**
 * Did the gate clear the exact tree this publish step shipped? One reader: the
 * NEWEST `verify`, the same record `lean/engine.ts`'s `landEarned` reads, plus the
 * rule that the green is about the head `publish` pushed. The `startedAt` filter
 * this used to carry was wrong: a re-run leaves a verdict NEWER than the publish,
 * and reading an older green over it told a host to merge work its gate had since
 * called red. A `ci` is read by position too, and only ever REJECTS — an absent
 * `ci` is unjudged, not refused (lean has no `ci` step built), while a newest `ci`
 * that is not green is the pipeline's verdict against the head the PR stands on.
 *
 * An outcome-less newest `verify` or `ci` is a crash mid-step, so the gate is
 * UNOBSERVED; a publish with no head, or a green with none, the same. Every one of
 * these goes to `draft`.
 */
export function gateClearedPublishedHead(steps: Step[], head: string | undefined): boolean {
  if (head === undefined) return false;
  // Absent `ci` is unjudged, not refused; but when a `ci` exists its NEWEST step
  // must be green — an outcome-less one is a crash mid-pipeline, not a green.
  const ci = newestAttempt(steps, "ci");
  if (ci !== undefined && ci.outcome?.kind !== "green") return false;
  const gate = newestAttempt(steps, "verify");
  if (gate?.outcome?.kind !== "green") return false;
  const verified = gate.outcome.verifiedHead;
  return typeof verified === "string" && isFullCommitSha(verified) && verified === head;
}

/**
 * Was the PR ready, a draft, or was there no PR at all? The typed answer to the
 * question exit 10 cannot ask.
 *
 * - `ready` — `counters.draft` is false, publish recorded `draft === false`, and
 *   the NEWEST `verify` is green about the very head publish says it shipped
 *   (an outcome-less newest `verify` is a crash, not a green), with no newest
 *   `ci` that is not green; a run with no `ci` step is unjudged, not refused;
 * - `draft` — `counters.draft` is true, or publish recorded `draft === true`, or
 *   anything about the claim is missing;
 * - `none` — no publish step left a PR URL.
 *
 * AN UNOBSERVED DRAFT STATE GOES TO `draft`, THE SAFE SIDE. `publish` records
 * the state the forge REPORTED rather than the one it asked for (that is
 * #1920 slice A's rule, and why the field is optional), so a publish outcome
 * with no `draft` is the one case where nobody knows. Guessing `ready` tells a
 * host to merge bytes its own gate never cleared; guessing `draft` costs a
 * person one look at the PR. The asymmetry decides it, and it decides every
 * missing half of the `ready` evidence the same way — `run.counters.draft`
 * included, which is the engine's own refusal (`landEarned` reads it FIRST).
 */
export function prStateOf(steps: Step[], draftCounter: boolean): IssueResult["prState"] {
  const publish = newestDecided(steps, "publish");
  if (publish === undefined || prUrlOf(steps) === undefined) return "none";
  // The forge's own answer, or the run's own counter: either needs no second opinion.
  if (draftCounter || publish.outcome?.draft === true) return "draft";
  // `ready` is the only claim needing every half of its evidence: the forge said
  // the PR is not a draft, the gate went green, and that green was about the head
  // publish pushed. Anything else is `draft`, the safe side: a host told `ready`
  // merges, a host told `draft` goes and looks.
  if (publish.outcome?.draft !== false) return "draft";
  return gateClearedPublishedHead(steps, publishedHeadOf(publish)) ? "ready" : "draft";
}

/** The two `review` outcome kinds that say the step RETURNED — `machine.ts`'s
 * `OUTCOME_KINDS.review`, exactly these two (`done` pushed nothing, `fixed` integrated
 * commits `integrate` pushes). Declared against that vocabulary because `Outcome.kind` is a
 * plain `string` and a bare literal here would let a typo compile into a silent third arm
 * that reads forever as "the review did not return". */
const REVIEW_DONE: OutcomeKind<"review"> = "done";
const REVIEW_FIXED: OutcomeKind<"review"> = "fixed";

/**
 * Did this run's review judge every lens it was bought, ON THE HEAD THE PR NOW STANDS ON?
 * Answered off the record, and only in the ways the record answers.
 *
 * **The head comes first.** `machine.ts` sends `publish` → `review`, and a CI-fix round runs
 * `publish` AGAIN after it, so the newest `review` step can sit BEHIND the newest `publish`
 * and have judged bytes the forge no longer holds; asking only that step would report a
 * finished review — and so the mergeable cap — over a head no lens read. The first question
 * is therefore LOG ORDER: any `publish` step after the newest `review` answers `false`,
 * decided or not (a publish that died mid-push recorded nothing, and nothing recorded cannot
 * be shown to have moved nothing). This is the other half of `prStateOf` above, and the two
 * disagree by design: publish's own rule says whether the forge left a ready PR, and only the
 * review says whether a lens read what is on it.
 *
 * Then the newest `review` step answers in three ways:
 *
 *   - it carries a `reviewBound` — `false`, whatever its lane list. A bound is what a STOP
 *     writes (`review.ts`'s `noteStop`) and a stopped step left work unbought: the two stops
 *     that let the step RETURN both sit after a fixer or a re-review that went unjudged, and
 *     `unjudgedLenses(…, true)` names that re-review in both — so no writer pairs a bound with
 *     a returned step whose lanes all came back, and the safe reading of "a stop was recorded"
 *     is not "the review finished". Presence is the predicate; the list does not outrank it;
 *   - it carries no bound — `true` only for a step that RETURNED (`done`/`fixed`), the
 *     engine's own way of saying the pass finished. A step that ended on a THROW is not that:
 *     `errorOutcome` copies a bound onto the outcome only when the thrown error carried one,
 *     and only the step-clock stop does, so the other throw sites — a head that moved before
 *     pass 1 was bought, a child the operator's budget stopped — land here having judged
 *     nothing. An absent outcome or a kind outside the vocabulary answers the same way, as
 *     `work-lean-gates.ts`'s reader already refuses to let an undecided review speak;
 *   - the log holds NO `review` step — `false`, whatever else the record says. The machine
 *     sends `publish` → `review`, so a `ready` PR with no review step is one the engine never
 *     dispatched (the deadline is checked before the NEXT state, and `stopForDeadline` stamps
 *     `handed-back` without it): the same silence one level up, and the arm this cap exists to
 *     refuse.
 *
 * So `true` is never a default — only ever something a step's own record said, about a head
 * nothing published over afterwards. Log POSITION decides which step is asked and whether its
 * verdict still describes the head; `kind` never decides which step is asked. Nothing here is
 * read off a reason line.
 */
export function reviewCompleteOf(steps: Step[]): boolean {
  const review = lastAttempt(steps, "review");
  if (review < 0) return false;
  if (lastAttempt(steps, "publish") > review) return false;
  const outcome = steps[review]?.outcome;
  if (outcome?.reviewBound !== undefined) return false;
  return outcome?.kind === REVIEW_DONE || outcome?.kind === REVIEW_FIXED;
}
