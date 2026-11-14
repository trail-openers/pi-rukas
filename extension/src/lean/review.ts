/**
 * lean/review — the run's gate: one adversarial pass, one six-lens pass, and one fix
 * wave between them.
 *
 * Both gates are the frozen driver's own code, called rather than copied:
 * `runAdversarialLoop` in report-only mode and `runLensReview` for the six lenses. What
 * is lean's own is which tree they read, who fixes what they find, and when the step
 * stops. Where the bytes are and how they move is `review-git.ts` and `review-tree.ts`;
 * the shapes the two gates are called with are `review-args.ts`; what the step says
 * about its own cost is `review-step.ts`; the one wave's policy is `review-waves.ts`;
 * the two children the full review buys are `review-pair.ts`; this file is the decision
 * procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A sha resolved from a ref
 * is the only value that cannot be dirtied underneath the step between two passes, so
 * origin's branch is resolved once and handed to both gates, the fixer and the
 * integration. Both gates get a ref range they compute their own diff from: a pasted
 * diff is a value the reviewer cannot re-read.
 *
 * **The fix runs in a disposable tree of its own** (lifecycle in `review-tree.ts`, the
 * wave in `review-git.ts`), detached at the reviewed commit and destroyed at the end of
 * the step — the fixer must not touch the tree `verify` and `publish` read. Detached on
 * purpose: a fixer that commits there moves no branch. Only the integration moves
 * anything, and only after its claims hold.
 *
 * **Two bounds, two jobs.** The shape of the wave is a module fact, not an operator
 * knob: `REVIEW_CHILD_BUDGET` in `review-waves.ts` states what one step may buy, and
 * `budgets.review` in `.pi/work.json` is the money, armed through the same `armBudget`
 * the other dispatching steps use. They are never divided into each other: a cap derived
 * from the turn budget can silently collapse to one round, and one round can fix but can
 * never re-review. A child that spends the budget is NOT a routed verdict the way
 * `build`/`challenge`/`specify` route theirs — this step has no `budget` arrow, so the
 * stop throws with the rows it paid for.
 *
 * **What a gate must say to buy a fixer.** A blocking row or a CRITICAL verdict, never a
 * verdict name. `CRITICAL_ISSUES_FOUND` is the adversarial gate's blocking one and
 * `ISSUES_FOUND`/`MINOR_OBSERVATIONS` are non-blocking; the lens layer reserves its
 * CRITICAL the same way and reaches `ISSUES_FOUND` at or above the project's bar
 * (`computeVerdict`), so the lens arm is judged on its rows (`lensBlocks`). The step
 * ENDS clean only when neither gate produced a blocking row or record, and its findings
 * are disclosed on the pass reason (`disclosureNote`).
 *
 * **What ends the step.** Both gates clean, on one of two kinds: `done` when no fix wave
 * ran, or `fixed` when the wave pushed commits and the run must re-verify the head. Which
 * one is read from the durable log, not a variable — see `fixedFromLog` in
 * `review-log.ts`.
 *
 * **One wave, not a loop.** One full review; if it blocks, ONE fixer given every
 * blocking finding at once; then ONE re-review ranged over the fix — or over the whole
 * branch when pass 1 carried a CRITICAL, since `rowFate` retires that class on a
 * complete full round only and a delta can never clear it. That upgrade REPLACES the
 * delta round, and an `REVIEW_INCOMPLETE` round is re-bought once behind a fresh clock
 * read. What a wave does not clear ends the step with a named cause: a gate that has said
 * the same thing twice across a fix is not a gate another paid round will satisfy.
 *
 * Anything else THROWS: a gate that produced no verdict, a head that moved or vanished
 * mid-wave, a fix wave that changed nothing, a CRITICAL the fix introduced, a fixer that
 * rewrote the frozen contract, an integration that could not be proven — and a child the
 * operator's budget stopped. A throw is the engine's infrastructure path: the run hands
 * back at exit 10 with the cause named. A gate that did not run is never a gate that
 * passed.
 *
 * **A budget stop is a throw here, not a routed kind — the opposite of `specify`,
 * `build` and `challenge`,** which each have a table arrow for `budget`. `review` has two
 * kinds and neither is a stop, so all three reads of a stopped child throw
 * {@link ReviewInfraError} with the shared `budgetSentence` and the rows the step bought.
 * Returned as `{kind: "budget"}` instead it reaches `settle` with no arrow for the pair
 * and the run's cause reads `no transition for review + "budget"`.
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
import {
  ROUNDS_MAX,
  type ReviewRoundCounts,
  WAVES_MAX,
  roundCounts,
} from "./state-outcome-gates.ts";
// The error lives in a leaf module so the extracted predicates can throw it without
// importing this handler back; re-exported so existing import sites keep working.
export { ReviewInfraError } from "./review-errors.ts";
// Re-exported for the same reason: the shapes live in `review-args.ts`.
export type {
  AdversarialArgs,
  FixRunId,
  LensArgs,
  LensRound,
  ReviewDeps,
} from "./review-args.ts";
// Re-exported for the same reason: the one-wave policy lives in `review-waves.ts`.
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
  // **THE ENTRY GATE, BEFORE ANYTHING IS PAID FOR OR TOUCHED.** The four refusals and the
  // reason their placement matters live in `review-entry.ts`.
  await assertReviewEntry({ repoRoot, branch, base, exec: deps.exec });

  // The contract, the config and the issue, all read before any child is paid: a step
  // that discovered its spec was unreadable after two passes had spent them for nothing.
  const frozen = frozenFromLog(ctx.steps);
  /**
   * The PR number of the PR this run's `publish` opened, from its recorded URL, or
   * undefined when none has recorded one. Read from the log rather than a closure so a
   * resumed run has it too (see `prNumberFromLog`).
   */
  const pr = prNumberFromLog(ctx.steps);
  const config = await deps.loadConfig(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(`could not load the project config: ${(err as Error).message}`);
  });
  const issueBody = await deps.fetchIssueBody(repoRoot, issue).catch((err: unknown) => {
    throw new ReviewInfraError(`could not read the issue: ${(err as Error).message}`);
  });
  // The blocking bar, resolved ONCE for the whole step at the run's base commit for the
  // same reason: it is a fact the step needs before it pays for a pass. Never per pass —
  // see `ReviewDeps.reviewThreshold`.
  const threshold = await deps.reviewThreshold(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(
      `could not resolve the project's review threshold: ${(err as Error).message}`,
    );
  });

  // The step's disposable trees are named once per attempt, so a resumed run re-enters
  // the paths its crashed self left (see `fixRunId`). Read from the log rather than a
  // closure because the attempt that pushed may be the one that crashed.
  const runId = fixRunIdFromLog(ctx.steps) ?? fixRunId(ctx.now);
  // The step's budget, armed the way `build`, `challenge` and `specify` arm theirs. A
  // child that spends it is NOT a routed verdict — this step has no `budget` arrow, so the
  // stop throws with the rows it paid for.
  const budget = armBudget(budgetFor(config, "review"));
  if (budget.warning !== undefined) traceWarn(`lean review #${String(issue)}: ${budget.warning}`);
  // **The step's OWN clock, beside the per-child arms and for a different job** — it
  // bounds the whole wave, and its spend comes off the durable review entry so a resumed
  // attempt counts what its crashed self spent. On a returned pass a stop is absent.
  const reviewMinutes = budgetFor(config, "review")?.minutes ?? 0;
  let boundRecord: ReviewBoundRecord | undefined;
  const clock = (): StepStop => stepBound(ctx, reviewMinutes, ctx.now());
  /** Record a stop, say it out loud, hand it back for the caller to route. */
  const noteStop = (stop: StepStop, wave: ReviewWave, lanes: string[]): ReviewBoundRecord => {
    boundRecord = reviewBoundRecord(stop, wave, lanes);
    traceWarn(`lean review #${String(issue)}: ${boundRecord.reason}`);
    return boundRecord;
  };
  const stopped = (rec: ReviewBoundRecord): ReviewInfraError =>
    Object.assign(new ReviewInfraError(rec.reason, rows), { reviewBound: rec });

  // `rows` accumulates across the WHOLE step, not one pass: the handback must say what
  // every child cost, including the one that failed. Nothing re-derives it per pass.
  const rows: DispatchUsageRow[] = [];
  let head = await reviewedHead(deps, repoRoot, branch, rows);
  /**
   * The step's account of what it judged, accumulated across the WHOLE step.
   *
   * `rows` is the cost of every child; this is the verdict of every round. Both are
   * step-wide rather than per-pass for the same reason: a host reading the run's record
   * asks what the review found in total, and a second pass that overwrote the first
   * would report a CRITICAL the run fixed as one the run never saw. `waves` holds only
   * the wave that actually pushed — a pass that cleared on the first round bought no
   * fixer and records no head.
   */
  const rounds: ReviewRoundCounts[] = [];
  const waves: { wave: "full" | "fix"; head: string }[] = [];
  /** Fold one judged round's rows into the published tally, at the record's own cap. */
  const noteRound = (round: LensRound): void => {
    if (rounds.length < ROUNDS_MAX)
      rounds.push(roundCounts([...round.reported, ...round.advisory]));
  };
  /** Record the head the one fix wave pushed, at the record's own cap. */
  const noteWave = (wave: "full" | "fix", pushed: string): void => {
    if (waves.length < WAVES_MAX) waves.push({ wave, head: pushed });
  };
  /** Attach what the step judged, so every exit — pass, wave, or stopped mid-wave —
   *  carries the rounds it actually judged rather than losing them on a stopped arm. */
  const withRecord = (pass: Outcome): Outcome => ({
    ...pass,
    ...(rounds.length === 0 && waves.length === 0
      ? {}
      : { review: { rounds: rounds.map((r) => ({ ...r })), waves: waves.map((w) => ({ ...w })) } }),
    ...(boundRecord === undefined ? {} : { reviewBound: boundRecord }),
  });
  // This attempt's number, from the log the engine resumes off — see
  // `reviewAttemptFromLog`. Part of the fix tree's name, so read once here.
  const attempt = reviewAttemptFromLog(ctx.steps);

  try {
    // ── pass 1: the full review — the adversarial gate AND the six lenses ─────
    // Both children are bought together and BOTH settle before the step reads a verdict:
    // that ordering, the single shared budget read and the no-orphans rule are
    // `buyFullReview`'s contract (see its header).
    //
    // R1: ONE clock read, immediately before the pair is bought. A live stop there hands
    // back naming the whole roster plus the re-review as unjudged; the pair is bought as
    // one unit, so there is no serial point between them for a second read.
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
    // Whether the ADVERSARIAL gate is what bought this wave, decided by the one thing
    // that says so — `gate.blocking`, the trailing record read by `blockingRecord` — and
    // never by whether findings were reported. Deriving it from their presence would
    // credit a disclosure with buying a fixer and break `fixTreeName`'s documented meaning
    // for the arm.
    const fromGate = gate.blocking;
    // The gate's findings, blocking or not: what the fixer's brief joins and what the
    // re-review is handed as `carried`.
    const carried = gate.findings;
    assertRan(review, rows);
    // A round that did not complete is refused BEFORE either verdict is read, in both
    // directions: not a pass to walk on, not a verdict to fix against. Checking the clean
    // bar first would let `REVIEW_INCOMPLETE` fall through into a `done`.
    // The round is judged and its rows are in hand: fold it into the tally BEFORE any
    // verdict is read, so an arm that refuses below still leaves the record saying what
    // the step saw. A round that did not run is refused and never reaches here.
    noteRound(review);
    if (LENS_DID_NOT_RUN.includes(review.verdict))
      throw new ReviewInfraError(
        `the six-lens review did not complete (${review.verdict}${review.note === undefined ? "" : `; disclosure: ${review.note}`}) — an incomplete round is not a pass to fix against`,
        rows,
      );
    if (!lensBlocks(review, threshold) && !gate.blocking) {
      // Neither gate blocked, so there is no wave and no re-review. Both halves of the bar
      // are the reviewing layers' own: `gate.blocking` is the loop's trailing record read
      // by `blockingRecord`, and `lensBlocks` is the layer's CRITICAL verdict or a reported
      // row at the project's bar.
      //
      // The gate's share is the STEP's to disclose, and this is the one exit where it has
      // no other consumer: with no wave there is no fixer's brief and no re-review, and the
      // residual post is the LENS layer's, which posts nothing on an APPROVED round. So the
      // gate's words ride the reason, neutralised by `disclosureNote`.
      return withRecord(
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
    // Reached only when something blocked. Both gates' outstanding findings go in one
    // brief — a fixer handed half of them would be re-run by a second wave, and there is
    // no second wave.
    //
    // `fromGate` is the ONE value that says which gate produced the findings, and every
    // derived part of the brief comes off it: the finding text, the gate name, and the
    // tree's arm.
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
    // The re-review's lower bound is the head the fix wave started from, as the wave
    // itself reported it — never a fresh read of origin, which by now may hold somebody
    // else's push. Held before the head moves, because after it the pre-fix head is not
    // recoverable from anything but this binding.
    const preFixHead = review.head;
    head = await assertFixAdvanced(review.head, fix.head, rows);
    // The wave pushed, so its head is a fact the record has to carry: the reason line
    // prints a 12-char prefix, and a host that has to check out what the fixer left
    // cannot clone a prefix.
    noteWave("fix", head);

    // R2: the fixer pushed, so the head origin holds is one nobody has re-judged. A stop
    // here is `fixed` — not a handback (the fix is already on the branch) and not a `done`
    // (`ci` would certify a head its gate never read after a fix): back through `verify`,
    // with the unjudged lanes disclosed.
    const preReReview = clock();
    if (preReReview.live) {
      noteStop(preReReview, "fix", unjudgedLenses(review, true));
      return withRecord(cleanPass(review, rows, true));
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
    noteRound(reReview);
    if (LENS_DID_NOT_RUN.includes(reReview.verdict)) {
      // The clock is read FRESH before spending on a retry: a stop with a pushed fix
      // routes `fixed`, disclosed, and never throws.
      const beforeRetry = clock();
      if (beforeRetry.live) {
        noteStop(beforeRetry, "fix", unjudgedLenses(review, true));
        return withRecord(cleanPass(reReview, rows, true));
      }
      // Only an INCOMPLETE round is re-bought, and once — a cap or a streak is another
      // component's budget, which no child this step pays can answer for.
      if (reReview.verdict !== "REVIEW_INCOMPLETE") throw refused(reReview);
      reReview = await lensGate(deps, ctx, reReviewOpts);
      assertRan(reReview, rows);
      if (LENS_DID_NOT_RUN.includes(reReview.verdict)) throw refused(reReview);
    }
    // THE RE-REVIEW MUST PROVE WHICH RANGE IT JUDGED, asked of the arm the step bought,
    // BEFORE the second gate pass is bought (see the two guards).
    if (full) await assertJudgedWholeBranch(deps, repoRoot, reReview, { head }, rows);
    else await assertRangedOverTheFix(deps, repoRoot, reReview, { since: preFixHead, head }, rows);
    // The adversarial gate's second pass runs AFTER the round it judges: its range is the
    // fix's own `since..head`. Running it before would have it judge a head whose verdict
    // the step has not read, and buy the reviewer for a re-review it will refuse.
    const reGate = await adversarialGate(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      wave: "fix",
      // The CRITICAL bar the second pass judges against: the rows the fix range itself is
      // allowed to introduce, read off the list the lenses were given.
      blockingFindings: blocking,
      rows,
      budget,
    });
    if (reGate.stop !== undefined) throw budgetStopped(reGate.stop, rows);
    // Both the re-review round and the second adversarial pass have run: every lane judged
    // once, so a stop here can only be a disclosure. What the pass disclosed, and each
    // refusal it can still raise, are read by `reviewedPass` off the rounds' own records.
    return withRecord(reviewedPass(reReview, reGate, { threshold, preFixHead, head, rows }));
  } finally {
    // One comment, whatever arm closed, and only on the forge channel: `publish` ran before
    // this step, so the PR body cannot carry the disclosure; on
    // `PI_ENSEMBLE_HANDOFF_CHANNEL=host` the host owns every post. A failed post never
    // changes the verdict — the record and the warn line already carry the stop.
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
    // An unscoped `-fix-` match would tear down a concurrent attempt's live tree.
    await closeFixTrees(deps, ctx, attempt, runId);
  }
}
