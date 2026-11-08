/**
 * lean/review — the run's gate: one adversarial pass, one six-lens pass, and
 * one fix wave between them.
 *
 * Both gates are the frozen driver's own code, called rather than copied:
 * `runAdversarialLoop` in report-only mode (it reviews and fixes nothing; this
 * step routes its verdict) and `runLensReview` for the six lenses. What is
 * lean's own is which tree they read, who fixes what they find, and when the
 * step stops. Where the bytes are and how they move is `review-git.ts` and
 * `review-tree.ts`; the shapes the two gates are called with are
 * `review-args.ts`; what the step says about its own cost is `review-step.ts`;
 * the one wave's policy it enforces is `review-waves.ts`; the two children the
 * full review buys, bought together, are `review-pair.ts`; this file is the
 * decision procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A commit sha
 * resolved from a ref is the only value that cannot be dirtied underneath the
 * step between two passes, so this step resolves origin's branch once and hands
 * the same value to both gates, the fixer, and the integration. Both gates get a
 * ref range they compute their own diff from rather than a pasted string: a
 * pasted diff is a value the reviewer cannot re-read, and a range is one it can.
 *
 * **The fix runs in a disposable tree of its own** (the tree lifecycle is in
 * `review-tree.ts`, the wave in `review-git.ts`), detached at the reviewed
 * commit and destroyed at the end of the step — because the fixer must not
 * touch the tree `verify` and `publish` read. A child loose in the run's
 * worktree between two gates would leave the green verdict describing one
 * commit and the PR holding another. Detached on purpose: a fixer that commits
 * there moves no branch, so it cannot corrupt what the run merges. Only the
 * integration moves anything, and only after its claims hold.
 *
 * **Two bounds, two jobs.** The shape of the wave is a module fact, not an
 * operator knob: `REVIEW_CHILD_BUDGET` in `review-waves.ts` states what one step
 * may buy, and `budgets.review` in `.pi/work.json` is the money, armed on every
 * child the step dispatches through the same `armBudget` the other three
 * dispatching steps use. They are never divided into each other: a cap derived
 * from the turn budget can silently collapse to one round, and one round can fix
 * but can never re-review — so the step would certify a head no gate had looked at
 * since its own fixer moved it. A child that spends the budget is NOT a routed
 * verdict the way `build`/`challenge`/`specify` route theirs — this step has no
 * `budget` arrow to route on, so the stop throws with the rows it paid for.
 *
 * **What a gate must say to buy a fixer.** A blocking row or a CRITICAL verdict,
 * never a verdict name. The adversarial gate's doctrine calls `CRITICAL_ISSUES_FOUND`
 * the blocking one and `ISSUES_FOUND`/`MINOR_OBSERVATIONS` explicitly non-blocking;
 * the six-lens layer reserves its CRITICAL verdict the same way and reaches
 * `ISSUES_FOUND` for anything at or above the project's bar (`computeVerdict`), so the
 * lens arm is judged on its rows (`lensBlocks`) rather than on that name. The step
 * therefore ENDS clean only when neither gate produced a blocking row or record —
 * no fixer, no re-review, no second gate pass — and its findings are disclosed on the
 * pass reason (`disclosureNote`). The step pays for a fix only where the reviewing
 * layer itself said the branch must not proceed.
 *
 * **What ends the step.** Both gates clean ends it, on one of two kinds that
 * differ only in what the step did to the branch: `done` when no fix wave ran
 * and the run goes to `ci`, or `fixed` when the wave pushed commits and the run
 * must re-verify the head it now has. Which of the two is read from the durable
 * log, not from a variable — see `fixedFromLog` in `review-log.ts` for why a
 * closure cannot answer that question for a resumed attempt.
 *
 * **One wave, not a loop.** One full review (the adversarial pass and the six
 * lenses); if it blocks, ONE fixer given every blocking finding at once; then
 * ONE re-review whose range is the fix — or the whole branch, when pass 1 carried a
 * CRITICAL: `rowFate` retires that class on a complete full round only, and a delta
 * can never clear it. That upgrade REPLACES the delta round, and an
 * `REVIEW_INCOMPLETE` round is re-bought once behind a fresh clock read. There is no
 * second wave and no round constant: what a wave does not clear ends the step with a
 * named cause, because a gate that has said the same thing twice across a fix is not
 * a gate another paid round will satisfy. The policy numbers live in
 * `review-waves.ts`.
 *
 * Anything else THROWS: a gate that produced no verdict, a head that moved or
 * vanished mid-wave, a fix wave that changed nothing, a blocking finding the
 * wave did not address, a CRITICAL the fix introduced, a fixer that rewrote the
 * frozen contract, an integration that could not be proven — and a child the
 * operator's budget stopped. A throw is the engine's infrastructure path — the
 * run hands back at exit 10 with the cause named, rather than carrying an
 * unreviewed head forward on a pass it did not earn. A gate that did not run is
 * never a gate that passed.
 *
 * **A budget stop is a throw here, not a routed kind — which is the opposite of
 * `specify`, `build` and `challenge`.** Those three have a table arrow for
 * `budget` and decide with it: `specify`/`build` hand back, `challenge` continues
 * to `verify`. `review` has two kinds and neither is a stop: anything that
 * is not both gates clearing must not route onward. So all three reads of a
 * stopped child — the adversarial reviewer, and the fixer on each of the two fix
 * arms — throw {@link ReviewInfraError} whose message is the shared
 * `budgetSentence` and whose rows are the children the step bought. Returned as
 * `{kind: "budget"}` instead it reaches `settle` with no arrow for the pair and
 * the run's cause reads `no transition for review + "budget"`: a broken-looking
 * table where the truth is a stopped child.
 */

import { isCarried } from "../lens-review-types.ts";
import type { runLensReview } from "../lens-review.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import { handoffChannel } from "../work-driver-handoff-channel.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
import {
  type StepStop,
  reviewBoundComment,
  reviewBoundRecord,
  stepBound,
  unjudgedLenses,
} from "./review-bound.ts";
import { assertReviewEntry } from "./review-entry.ts";
import { adversarialGate, lensGate } from "./review-gates.ts";
import { fixRound, reviewedHead } from "./review-git.ts";
import {
  fixRunId,
  fixRunIdFromLog,
  fixedFromLog,
  prNumberFromLog,
  reviewAttemptFromLog,
} from "./review-log.ts";
import { buyFullReview } from "./review-pair.ts";
import { cleanPass, disclosureNote } from "./review-pass.ts";
import { assertFixAdvanced } from "./review-progress.ts";
import {
  assertJudgedWholeBranch,
  assertRan,
  assertRangedOverTheFix,
} from "./review-round-guards.ts";
import { budgetStopped, reviewedPass } from "./review-step.ts";
import { closeFixTrees } from "./review-tree.ts";
import {
  CAUSE_NO_CHANGE,
  LENS_DID_NOT_RUN,
  atOrAboveBar,
  carriedCriticalIn,
  lensBlocks,
} from "./review-waves.ts";
import { specifyBranch } from "./specify-tree.ts";
// The error lives in a leaf module so the extracted predicates can throw it without
// importing this handler back. Re-exported so every existing `import { ... }
// from "./review.ts"` — including the smoke fixtures' — keeps working.
export { ReviewInfraError } from "./review-errors.ts";
// The shapes the step's participants compile against live in `review-args.ts`:
// re-exported so every existing `import { ... } from "./review.ts"` — including
// the smoke fixtures' — keeps working.
export type {
  AdversarialArgs,
  FixRunId,
  LensArgs,
  LensRound,
  ReviewDeps,
} from "./review-args.ts";
// The one-wave policy — the child budget, the blocking bar and the named handback
// causes — lives in `review-waves.ts`; re-exported for the same reason as the
// argument shapes.
export {
  CAUSE_NEW_CRITICAL,
  CAUSE_NO_CHANGE,
  CAUSE_NOT_ADDRESSED,
  LENS_DID_NOT_RUN,
  PASS_ROWS,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
} from "./review-waves.ts";
import type { LensRound, ReviewDeps, ReviewWave } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import type { Outcome, ReviewBoundRecord } from "./state.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { armBudget, budgetFor } from "./step-budget.ts";

/** The fixer's wall clock, the shape the other steps pass as `childBoundMs`. */
export const FIX_BOUND_MS = 20 * 60_000;

/**
 * The `review` step. Returns one of the step's two pass kinds — `done` or
 * `fixed` (see `passKind` in `review-step.ts` for what the two differ in); a
 * budget stop is NOT returned, it throws; and so does anything else.
 */
export async function reviewOutcome(ctx: HandlerCtx, deps: ReviewDeps): Promise<Outcome> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  const base = ctx.run.baseSha;
  // **THE ENTRY GATE, BEFORE ANYTHING IS PAID FOR OR TOUCHED.** The four refusals
  // and the reason their placement is the substance of the change live in
  // `review-entry.ts`, whose whole contract is "refuse a run this step must not
  // start"; the ordering mutation that proves the guarantee is stated at the push
  // site in `review-git.ts`.
  await assertReviewEntry({ repoRoot, branch, base });

  // The contract, the config and the issue, all read before any child is paid:
  // a step that discovered its spec was unreadable after two passes of review
  // had spent those passes for nothing.
  const frozen = frozenFromLog(ctx.steps);
  /**
   * The PR number of the PR this run's `publish` opened, from its recorded URL —
   * or undefined when no step has recorded one. Read from the log rather than a
   * closure so a resumed run has it too, and derived rather than stored: `publish`
   * records the URL and this is its tail (see `prNumberFromLog`).
   */
  const pr = prNumberFromLog(ctx.steps);
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const issueBody = await deps.fetchIssueBody(repoRoot, issue).catch((err: unknown) => {
    throw new ReviewInfraError(`could not read the issue: ${(err as Error).message}`);
  });
  // The blocking bar, resolved ONCE for the whole step at the run's base commit,
  // beside the config and the issue and for the same reason: it is a fact the
  // step needs before it pays for a pass, and a step that discovered its bar was
  // unreadable after a review would have spent that review at the wrong one.
  // Never per pass — see `ReviewDeps.reviewThreshold`.
  const threshold = await deps.reviewThreshold(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(
      `could not resolve the project's review threshold: ${(err as Error).message}`,
    );
  });

  // The step's disposable trees are named once per attempt, so a resumed run
  // re-enters the paths its crashed self left (see `fixRunId`). There is one wave,
  // so one name serves; the value still comes from the log rather than a
  // closure because the attempt that pushed may be the one that crashed.
  const runId = fixRunIdFromLog(ctx.steps) ?? fixRunId(ctx.now);
  // The step's budget, armed the way `build`, `challenge` and `specify` arm theirs.
  // A child that spends it is NOT a routed verdict the way those steps route theirs —
  // this step has no `budget` arrow to route on, so the stop throws with the rows it
  // paid for.
  const budget = armBudget(budgetFor(config, "review"));
  if (budget.warning !== undefined) traceWarn(`lean review #${String(issue)}: ${budget.warning}`);
  // **The step's OWN clock, beside the per-child arms and for a different job** — it
  // bounds the whole wave, and its spend comes off the durable review entry so a
  // resumed attempt counts what its crashed self spent. A stop is `traceWarn`, not
  // the debug-gated `trace`. On a returned pass a stop is absent entirely.
  const reviewMinutes = budgetFor(config, "review")?.minutes ?? 0;
  let boundRecord: ReviewBoundRecord | undefined;
  const clock = (): StepStop => stepBound(ctx, reviewMinutes, ctx.now());
  /** Record a stop, say it out loud, hand the record back for the caller to route:
   * pass-1 handback, `fixed` after a push, or a bare disclosure. */
  const noteStop = (stop: StepStop, wave: ReviewWave, lanes: string[]): ReviewBoundRecord => {
    boundRecord = reviewBoundRecord(stop, wave, lanes);
    traceWarn(`lean review #${String(issue)}: ${boundRecord.reason}`);
    return boundRecord;
  };
  const stopped = (rec: ReviewBoundRecord): ReviewInfraError =>
    Object.assign(new ReviewInfraError(rec.reason, rows), { reviewBound: rec });
  const withBound = (pass: Outcome): Outcome =>
    boundRecord === undefined ? pass : { ...pass, reviewBound: boundRecord };

  // `rows` accumulates across the WHOLE step, not one pass: the handback must say
  // what every child cost, including the one that failed. Nothing re-derives it
  // per pass — a total rebuilt for the re-review reports a two-pass run to the
  // operator as a one-pass one.
  const rows: DispatchUsageRow[] = [];
  let head = await reviewedHead(deps, repoRoot, branch, rows);
  // This attempt's number, from the log the engine resumes off — see
  // `reviewAttemptFromLog`. It is part of the fix tree's name, so it is read once
  // here rather than derived per pass.
  const attempt = reviewAttemptFromLog(ctx.steps);

  try {
    // ── pass 1: the full review — the adversarial gate AND the six lenses ─────
    // Both children are bought together and BOTH settle before the step reads a
    // verdict: the ordering, the single shared budget read and the no-orphans rule
    // are `buyFullReview`'s contract (see its header) rather than something to
    // re-derive from a call site.
    //
    // R1: ONE clock read, immediately before the pair is bought. A live stop there
    // hands back — nothing reviewed, no verdict to proceed on and no head to
    // certify — naming the whole roster plus the re-review as unjudged. The pair is
    // bought as one unit, so there is no serial point between them to read a second
    // stop at.
    const handback = (stop: StepStop, lanes: string[]): never => {
      throw stopped(noteStop(stop, "full", lanes));
    };
    const prePair = clock();
    if (prePair.live) handback(prePair, unjudgedLenses(undefined));
    const { gate, review } = await buyFullReview(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      pr,
      threshold,
      rows,
      budget,
    });
    // Whether the ADVERSARIAL gate is what bought this wave, decided by the one
    // thing that says so — `gate.blocking`, the trailing record read by
    // `blockingRecord` — and never by whether findings were reported. A
    // non-blocking gate still has findings, and deriving the gate's contribution
    // from their presence would credit a disclosure with buying a fixer: the brief
    // would name "adversarial pass" for findings the loop itself declined to stop
    // the run for, the tree's arm would say `a` for a pass the six-lens round alone
    // blocked on, and `fixTreeName`'s documented meaning of the arm would stop
    // matching the step.
    const fromGate = gate.blocking;
    // The gate's findings — blocking or not — which is what `findings` below joins
    // into the fixer's brief and what the re-review is handed as `carried`. Named
    // here rather than at the fix wave so the one value the gate contributes to the
    // rest of the step is visible in one place.
    const carried = gate.findings;
    assertRan(review, rows);
    // A round that did not complete is refused BEFORE either verdict is read, in
    // both directions: it is not a pass to walk on, and it is not a verdict to fix
    // against. Checking the clean bar first would let `REVIEW_INCOMPLETE` fall
    // through the non-blocking branch into a `done` — a head nobody reviewed
    // certified.
    if (LENS_DID_NOT_RUN.includes(review.verdict))
      throw new ReviewInfraError(
        `the six-lens review did not complete (${review.verdict}${review.note === undefined ? "" : `; disclosure: ${review.note}`}) — an incomplete round is not a pass to fix against`,
        rows,
      );
    if (!lensBlocks(review, threshold) && !gate.blocking) {
      // Neither gate blocked, so there is no wave and no re-review: the run goes
      // on as it always did. Both halves of the bar are the reviewing layers' own:
      // `gate.blocking` is the loop's trailing record read by `blockingRecord`, and
      // `lensBlocks` is the layer's CRITICAL verdict or a reported row at the
      // project's bar — a reviewer that reported findings below the bar without
      // stopping the run has the lenses' share disclosed by the review layer, and
      // the step pays nobody to fix what the reviewing layer itself declined to
      // block on.
      //
      // The gate's share, though, is the STEP's to disclose, and this is the one
      // exit on which it has no other consumer at all: with no wave there is no
      // fixer's brief to join it into and no re-review to carry it, and the
      // residual post is the LENS layer's, which posts nothing on an APPROVED round.
      // So the gate's own words ride the reason, neutralised and bounded by
      // `disclosureNote` — the same note `reviewedPass` puts on a cleared wave.
      // Without them an unposted non-blocking verdict reaches no durable surface.
      return withBound(
        cleanPass(
          review,
          rows,
          fixedFromLog(ctx.steps),
          disclosureNote(
            review.reported.filter((f) => !isCarried(f) && !atOrAboveBar(f, threshold)).length,
            gate.open ? carried : "",
          ),
        ),
      );
    }

    // The wave has not started, so this is still a pass-1 stop: handback.
    const preFix = clock();
    if (preFix.live) handback(preFix, unjudgedLenses(review));

    // ── the one fix wave: a single fixer, given every blocking finding ────────
    // Reached only when something blocked: the lens round's CRITICAL verdict, or
    // the adversarial record `blockingRecord` called blocking. Both gates'
    // outstanding findings then go in one brief — a fixer handed half the findings
    // would be re-run by a second wave to be told the rest, and there is no second
    // wave.
    //
    // `fromGate` is the ONE value that says which gate produced the findings, and
    // every derived part of the fixer's brief comes off it: the finding text, the
    // gate name the brief prints, and the tree's arm. Three independent readings
    // of "did the adversarial pass contribute?" is how they start disagreeing.
    const blocking = review.findings;
    const findings = fromGate ? [carried, blocking].join("\n\n") : blocking;
    const gateName = fromGate
      ? `adversarial pass and six-lens review (${review.verdict})`
      : `six-lens review (${review.verdict})`;
    const fix = await fixRound(deps, ctx, {
      head: review.head,
      frozen,
      findings,
      issueBody,
      gate: gateName,
      wave: "full",
      // The arm the tree's name carries: "a" when the findings came from the
      // adversarial gate, "l" when the six-lens round raised them. See `fromGate`.
      arm: fromGate ? "a" : "l",
      attempt,
      runId,
      rows,
      budget,
    });
    if (fix.stop !== undefined) throw budgetStopped(fix.stop, rows);
    // The range the re-review reads is bounded BELOW by the head the fix wave
    // started from, and that value is what the wave itself reported — never a
    // fresh read of origin, which by now may hold somebody else's push. Held
    // before the head moves, because after the move the pre-fix head is not
    // recoverable from anything but this binding.
    const preFixHead = review.head;
    head = await assertFixAdvanced(review.head, fix.head, rows);

    // R2: the fixer pushed, so the head origin holds is one nobody has re-judged.
    // A stop here is `fixed` — neither a handback (the fix is already on the branch,
    // and throwing would strand it with the run handing back over a moved head) nor
    // a `done` (`ci` would certify a head its gate never read after a fix): back
    // through `verify`, with the unjudged lanes disclosed.
    const preReReview = clock();
    if (preReReview.live) {
      noteStop(preReReview, "fix", unjudgedLenses(review, true));
      return withBound(cleanPass(review, rows, true));
    }

    // ── pass 2: the re-review. A delta over the fix, or whole-branch when pass 1
    // carried a CRITICAL; bought once, re-bought once if it did not complete. ────
    // The rows pass 1 just judged, both tiers — see `carriedCriticalIn`.
    const full = carriedCriticalIn([...review.reported, ...review.advisory]);
    const reReviewOpts = {
      base,
      branch,
      wave: "fix" as const,
      issueBody,
      pr,
      carried,
      // `full` names the layer's own opt-out from its automatic delta base, which no
      // missing `since` alone would suppress.
      ...(full ? { full: true } : { since: preFixHead }),
      rows,
      budget,
      threshold,
    };
    let reReview = await lensGate(deps, ctx, reReviewOpts);
    const refused = (round: LensRound): ReviewInfraError =>
      new ReviewInfraError(
        `the re-review of the fix did not complete (${round.verdict}${round.note === undefined ? "" : `; disclosure: ${round.note}`}) — an incomplete round is not evidence that the fix answered anything`,
        rows,
      );
    assertRan(reReview, rows);
    if (LENS_DID_NOT_RUN.includes(reReview.verdict)) {
      // The clock is read FRESH before spending on a retry: a stop with a pushed fix
      // routes `fixed`, disclosed, and never throws.
      const beforeRetry = clock();
      if (beforeRetry.live) {
        noteStop(beforeRetry, "fix", unjudgedLenses(review, true));
        return withBound(cleanPass(reReview, rows, true));
      }
      // Only an INCOMPLETE round is re-bought, and once — a cap or a streak is another
      // component's budget, which no child this step pays can answer for.
      if (reReview.verdict !== "REVIEW_INCOMPLETE") throw refused(reReview);
      reReview = await lensGate(deps, ctx, reReviewOpts);
      assertRan(reReview, rows);
      if (LENS_DID_NOT_RUN.includes(reReview.verdict)) throw refused(reReview);
    }
    // THE RE-REVIEW MUST PROVE WHICH RANGE IT JUDGED, asked of the arm the step
    // bought, BEFORE the second gate pass is bought (see the two guards).
    if (full) await assertJudgedWholeBranch(deps, repoRoot, reReview, { head }, rows);
    else await assertRangedOverTheFix(deps, repoRoot, reReview, { since: preFixHead, head }, rows);
    // The adversarial gate's second pass runs AFTER the round it judges:
    // its range is the fix's own `since..head`, the same range the lenses were
    // handed. Running it before the round would have it judge a head whose
    // verdict the step has not yet read, and a re-review the step already knows
    // it will refuse would have bought the reviewer for nothing.
    const reGate = await adversarialGate(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      wave: "fix",
      // The CRITICAL bar the second pass judges against: the rows the fix range
      // itself is allowed to introduce. Read off the same list the lenses were
      // given, not re-derived from prose.
      blockingFindings: blocking,
      rows,
      budget,
    });
    if (reGate.stop !== undefined) throw budgetStopped(reGate.stop, rows);
    // Both the re-review round and the second adversarial pass have run: the wave is
    // complete, every lane judged once, so a stop here can only be a disclosure.
    // What the pass says it disclosed, and each refusal it can still raise, are read
    // by `reviewedPass` off the two rounds' own records.
    return withBound(reviewedPass(reReview, reGate, { threshold, preFixHead, head, rows }));
  } finally {
    // One comment, whatever arm closed, and only on the forge channel: `publish` ran before
    // this step, so the PR body cannot carry the disclosure; on
    // `PI_ENSEMBLE_HANDOFF_CHANNEL=host` the host owns every post, as the two reporting
    // steps do. A failed post never changes the verdict — the record and the warn line
    // already carry the stop.
    if (
      boundRecord !== undefined &&
      handoffChannel() !== "host" &&
      pr !== undefined &&
      deps.prComment !== undefined
    ) {
      await deps
        .prComment(repoRoot, pr, reviewBoundComment(boundRecord))
        .catch((err: unknown) =>
          traceWarn(
            `lean review #${String(issue)}: could not post the unreviewed-lanes disclosure: ${(err as Error)?.message ?? String(err)}`,
          ),
        );
    }
    // Scoped to THIS attempt's trees (issue, attempt, epoch) — see `closeFixTrees`.
    // An unscoped `-fix-` match tore down a concurrent attempt's live tree, which
    // is the case `test-lean-review-tree.ts` (w) now drives.
    await closeFixTrees(deps, ctx, attempt, runId);
  }
}
