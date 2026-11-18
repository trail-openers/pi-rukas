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
 * a LENS read what stands on the PR" — and its answer is the published head put against the
 * head the review itself says it judged, a fact this module already owns.
 *
 * The load-bearing rule is in `gateClearedPublishedHead`: a green is worth nothing unless
 * it is about the head that shipped, and a newest step with no outcome is a crash, not a
 * verdict. Wherever evidence is missing the answer is `draft`, the safe side — a host
 * told `ready` merges, a host told `draft` goes and looks.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { OutcomeKind } from "../lean/machine.ts";
import { validPrUrl } from "../lean/state-outcome.ts";
import type { Outcome, Step } from "../lean/state.ts";
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
 * **The head comes first, and it is read as an IDENTITY, not as a position.** `machine.ts`
 * sends `publish` → `review`, and it routes `review + fixed` → `verify` → `publish`: a review
 * that found findings and fixed them ALWAYS has a `publish` after it — the re-attestation of
 * the head its own `integrate` pushed — and a CI-fix round runs `publish` again after that.
 * Position alone called that whole legitimate class unfinished, which made the mergeable cap
 * unreachable for every PR whose review found anything. So the question is whether the
 * review's record COVERS the currently published head, in the one shape the record carries
 * it: a `fixed` review that ran a wave names the full head it pushed in
 * `outcome.review.waves[]` (the same field `gates.review.waves` publishes), and the newest
 * decided `publish` names the head it shipped in `publishedHead`. Equal ⇒ every lens read
 * what the PR stands on (`review-step.ts`'s `reviewedPass` refuses the wave until the
 * re-review has ranged over the fix and the second adversarial pass has read it); different
 * ⇒ a real move after the review — a genuine CI-fix round ships a commit no wave of the
 * review named — and the answer is `false`. An undecided `publish` anywhere after the review
 * decides nothing (a push whose outcome nobody wrote cannot be shown to have moved nothing),
 * and a decided publish with no head, or none at all, cannot be shown to match either.
 *
 * **Where the record names no head of its own push, POSITION is the rule** — a head is only
 * the step's to certify when its own `integrate` pushed it, and the records that reach the
 * position rule are the ones that name none: a plain `done` — it ran no wave, and the
 * machine's table forbids the alternative of a `fixed` arriving name-less from the step
 * (`review` is routed only from `publish + ok` with `reviewDone` false and both returned
 * kinds set it, so a decided `review` is never followed by a second one, and `resume.ts`
 * re-derives its counters by replaying the log and checks them against the snapshot, so a
 * resumed attempt cannot carry another attempt's wave either) — or a `fixed` whose record
 * names no USABLE wave head: no `waves` array, an empty one, or a newest entry whose head
 * is not an oid (`lastWaveHead`). Neither kind can certify from a head it does not name,
 * and position is the only rule such a record can have: any `publish` attempt at a higher
 * index — decided or not — answers `false`, because a step the machine did not route through a
 * re-publish can only have had its head moved by a later push, and log order is all the record
 * has to say about that.
 *
 * **Identity is predicated on a judged round.** `review.ts` folds pass 1 into
 * `outcome.review.rounds` with `noteRound` BEFORE either verdict is read, and its only
 * `noteWave` sits below that fold — so in a record the step itself wrote, every wave stands
 * behind a round that ran. The loader cannot close the gap the other way: it bounds `rounds`
 * from above and never asks for one (`reviewRecordProblem` accepts an empty array), so a
 * record that reaches this projection by any other route can name a wave's head with no
 * round vouching for it. A `fixed` record whose `rounds` is absent or empty therefore
 * answers `false` beside its waves: a head no round is on record as judged is a head no
 * lens read, whatever its waves name.
 *
 * Then the newest `review` step itself answers in three ways:
 *
 *   - it carries a `reviewBound` — `false`, whatever its lane list and whatever its waves. A
 *     bound is what a STOP writes (`review.ts`'s `noteStop`) and a stopped step left work
 *     unbought: the two stops that let the step RETURN both sit after a fixer or a re-review
 *     that went unjudged, and `unjudgedLenses(…, true)` names that re-review in both — so no
 *     writer pairs a bound with a returned step whose lanes all came back, and the safe
 *     reading of "a stop was recorded" is not "the review finished". Presence is the
 *     predicate; the list and the waves do not outrank it;
 *   - its kind is outside the two that say the step RETURNED (`done`/`fixed`) — `false`.
 *     A step that ended on a THROW is not a finished pass: `errorOutcome` copies a bound onto
 *     the outcome only when the thrown error carried one, and only the step-clock stop does,
 *     so the other throw sites — a head that moved before pass 1 was bought, a child the
 *     operator's budget stopped — land here having judged nothing. An absent outcome answers
 *     the same way, as `work-lean-gates.ts`'s reader already refuses to let an undecided
 *     review speak;
 *   - the log holds NO `review` step — `false`, whatever else the record says. The machine
 *     sends `publish` → `review`, so a `ready` PR with no review step is one the engine never
 *     dispatched (the deadline is checked before the NEXT state, and `stopForDeadline` stamps
 *     `handed-back` without it): the same silence one level up, and the arm this cap exists to
 *     refuse.
 *
 * So `true` is never a default — only ever something a step's own record said, either the
 * head it pushed matching the head that shipped, or (having named no head) its own position
 * ahead of every push. Nothing here is read off a reason line.
 */
export function reviewCompleteOf(steps: Step[]): boolean {
  const review = lastAttempt(steps, "review");
  if (review < 0) return false;
  const outcome = steps[review]?.outcome;
  if (outcome?.reviewBound !== undefined) return false;
  if (outcome?.kind !== REVIEW_DONE && outcome?.kind !== REVIEW_FIXED) return false;
  const wave = outcome?.kind === REVIEW_FIXED ? lastWaveHead(outcome) : undefined;
  if (wave === undefined) return lastAttempt(steps, "publish") < review;
  // The wave arm's precondition, outranking identity as the bound's presence does: no
  // record with waves but no judged round is one the step's own writer can leave behind
  // (see the jsdoc), and a head no round is on record as judged certifies nothing.
  const rounds = outcome?.review?.rounds;
  if (!Array.isArray(rounds) || rounds.length === 0) return false;
  // Undecided-inclusive, as the position rule is: one publish attempt after the review that
  // recorded nothing can have moved the head past the wave this record names.
  for (let i = review + 1; i < steps.length; i++)
    if (steps[i]?.state === "publish" && steps[i]?.outcome === undefined) return false;
  return publishedHeadOf(newestDecided(steps, "publish")) === wave;
}

/** The full head the review's own record says its newest wave pushed, re-checked with the
 * shape rule the loader enforces (this log need not have passed through it), or `undefined`
 * when the record names none — no waves array, an empty one, or a newest entry whose head is
 * not an oid. A record that cannot name its head cannot certify that the published head is
 * it, and the caller falls back to the position rule, which is what such records had before
 * their own heads were on the record at all. */
function lastWaveHead(outcome: Outcome | undefined): string | undefined {
  const waves = outcome?.review?.waves;
  if (!Array.isArray(waves) || waves.length === 0) return undefined;
  const head = waves[waves.length - 1]?.head;
  return typeof head === "string" && isFullCommitSha(head) ? head : undefined;
}
