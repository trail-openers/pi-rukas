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
 * the one-wave policy it enforces is `review-waves.ts`; this file is the
 * decision procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A gate approves
 * the bytes at a commit, and the only value that cannot be dirtied underneath
 * the step between two passes is a commit sha resolved from a ref. This step
 * resolves origin's branch and hands the same value to both gates, to the
 * fixer, and to the integration — five uses of one commit cannot disagree, and
 * a working copy would give each of them a different tree. Both gates therefore
 * get a ref range they compute their own diff from rather than a string this
 * step pasted: a pasted diff is a value the reviewer cannot re-read, and a
 * range is one it can.
 *
 * **The fix runs in a disposable tree of its own** (the tree lifecycle is in
 * `review-tree.ts`, the wave in `review-git.ts`), detached at the reviewed
 * commit and destroyed at the end of the step — because the fixer must not
 * touch the tree `verify` and `publish` read. A child loose in the run's
 * worktree between two gates would leave the green verdict describing one
 * commit and the PR holding another. Detached on
 * purpose: a fixer that commits there moves no branch, so a child that committed
 * twice, amended, or reset could not corrupt what the run merges. Only the
 * integration moves anything, and only after its claims hold.
 *
 * **Two bounds, two jobs.** The shape of the wave is a module fact, not an
 * operator knob: `REVIEW_CHILD_BUDGET` in `review-waves.ts` states what one step
 * may buy, and `budgets.review` in `.pi/work.json` is the money, armed on every
 * child the step dispatches through the same `armBudget` the other three
 * dispatching steps use. They are never divided into each other. Deriving a cap
 * from the turn budget (`turns / TURNS_PER_ROUND`) once shipped a default budget
 * of **one round**, and one round can fix but can never re-review — so the step
 * certified a head no gate had looked at since its own fixer moved it. The
 * budget stays fully live and stays the stop condition the operator owns: it is
 * armed on every child through `armBudget`. A child that spends it is NOT a
 * routed verdict the way `build`/`challenge`/`specify` route theirs — this step
 * has no `budget` arrow to route on, so the stop throws with the rows it paid for
 * (see below for why the two shapes differ).
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
 * ONE re-review whose range is the fix, which decides each blocking finding
 * ADDRESSED or NOT ADDRESSED and whether the fix itself introduced a CRITICAL.
 * There is no second wave and no round constant — the machinery that bounded a
 * repeating loop (the round cap, the stagnation tie-breaker, the per-round tree
 * naming) is deleted, not left behind as insurance. What a wave does not clear
 * ends the step with a named cause, because a gate that has said the same thing
 * twice across a fix is not a gate another paid round will satisfy. The
 * measurements behind that policy are in `review-waves.ts`.
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
 * to `verify` (#1883). `review` has two kinds and neither is a stop: anything that
 * is not both gates clearing must not route onward. So all three reads of a
 * stopped child — the adversarial reviewer, and the fixer on each of the two fix
 * arms — throw {@link ReviewInfraError} whose message is the shared
 * `budgetSentence` and whose rows are the children the step bought. Returned as
 * `{kind: "budget"}` instead it reaches `settle` with no arrow for the pair and
 * the run's cause reads `no transition for review + "budget"`: a broken-looking
 * table where the truth is a stopped child.
 */

import type { Verdict } from "../lens-review-format.ts";
import type { runLensReview } from "../lens-review.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchSpec } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import { frozenFromLog } from "./build.ts";
import type { HandlerCtx } from "./engine.ts";
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
import { assertFixAdvanced } from "./review-progress.ts";
import { budgetStopped, passKind } from "./review-step.ts";
import { closeFixTrees } from "./review-tree.ts";
import {
  CAUSE_NEW_CRITICAL,
  CAUSE_NO_CHANGE,
  CAUSE_NOT_ADDRESSED,
  classifyFates,
  openFindings,
} from "./review-waves.ts";
import { specifyBranch } from "./specify-tree.ts";
import { DISPATCHES_MAX_ROWS } from "./state-outcome.ts";
// The error lives in a leaf module so the extracted predicates can throw it without
// importing this handler back. Re-exported so every existing `import { ... }
// from "./review.ts"` — including the smoke fixtures' — keeps working.
export { ReviewInfraError } from "./review-errors.ts";
// The shapes the step's participants compile against live in `review-args.ts`:
// re-exported so every existing `import { ... } from "./review.ts"` — including
// the smoke fixtures' — keeps working.
export type {
  AdversarialArgs,
  FindingFate,
  FindingOutcome,
  FixRunId,
  LensArgs,
  LensRound,
  ReviewDeps,
} from "./review-args.ts";
// The one-wave policy — the child budget and the named handback causes — lives in
// `review-waves.ts`; re-exported for the same reason as the argument shapes.
export {
  CAUSE_NEW_CRITICAL,
  CAUSE_NO_CHANGE,
  CAUSE_NOT_ADDRESSED,
  PASS_ROWS,
  REVIEW_CHILD_BUDGET,
  REVIEW_PASSES,
} from "./review-waves.ts";
import type { LensRound, ReviewDeps } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import type { Outcome } from "./state.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { armBudget, budgetFor } from "./step-budget.ts";

/**
 * What this step may never "fix" its way past.
 *
 * A lens round that did not complete reviewed nothing, so its verdict is not
 * evidence to fix against: an empty round whose fixer then changed nothing would
 * read as a resolution and let the run merge unreviewed. The round-cap verdicts
 * are another component's budget refusing this run, which a fix round cannot
 * answer — the operator named that budget, and only they can lift it.
 *
 * Typed against the review layer's own `Verdict` union: a `string[]` compared
 * against a widened `verdict: string` lets a renamed verdict silently stop
 * matching, and the round it was meant to refuse would then be fixed against.
 */
const NO_FIX_VERDICTS: readonly Verdict[] = [
  "REVIEW_INCOMPLETE",
  "ROUND_CAP_REACHED",
  "REVIEW_INCOMPLETE_STREAK",
];

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
  // The step's budget, armed the way `build`, `challenge` and `specify` arm
  // theirs. `armBudget` turns `budgets.review` into the three levers a child
  // actually gets — `minutes`→`childBoundMs`, `turns`/`tokens`→ an abort off the
  // progress stream — and `fired` reads back which one ended a child. Before
  // this the step read `budgets.review.turns` for one division and armed
  // NOTHING, so a review ran its reviewer, its six lenses and its fixer under
  // the generic child bound while the operator's ceilings sat unread: the pilot
  // that reported "minutes budget 20 exceeded (used 31)" beside a child that ran
  // 1,800,180 ms is that gap. The other steps honour this budget; deleting the
  // fields instead would have deleted the operator's only lever over what a
  // review costs.
  const budget = armBudget(budgetFor(config, "review"));
  if (budget.warning !== undefined) traceWarn(`lean review #${String(issue)}: ${budget.warning}`);
  // What the turns lever is, for the cause line only. It bounds a CHILD's turn
  // count (armed on every child through `armBudget`, which aborts the child whose
  // progress passes it) — it never bounded the SHAPE of the wave, which is
  // `REVIEW_CHILD_BUDGET` alone. Naming the number here says only what it bounds,
  // so an operator raising `turns` is not led to expect another pass.
  const turnCap = budgetFor(config, "review")?.turns ?? 0;

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
    // ── pass 1: the full review — the adversarial gate, then the six lenses ──
    const gate = await adversarialGate(deps, ctx, {
      base,
      head,
      branch,
      issueBody,
      wave: "full",
      rows,
      budget,
    });
    // The operator's ceiling stopping this step is read BEFORE the gate's own
    // infra throw could mistake a stopped reviewer for "no verdict at all", and
    // it THROWS: both arrows out of `review` are clean passes, so a stopped
    // child has no route and must not be mistaken for one (see this file's
    // header for why this step throws where the other three route).
    if (gate.stop !== undefined) throw budgetStopped(gate.stop, rows);
    // Findings the adversarial pass passed on without blocking travel to the
    // lenses, which are told to judge them; the lens round's `carried` parameter
    // exists for this one value and nothing else.
    const carried = gate.findings;

    const review = await lensGate(deps, ctx, {
      base,
      branch,
      wave: "full",
      pr,
      carried,
      rows,
      budget,
      threshold,
    });
    assertRan(review, rows);
    if (review.verdict === "APPROVED" && carried === "") {
      // Nothing blocked at either gate, so there is no wave and no re-review: the
      // run goes on as it always did. `carried === ""` is the adversarial gate's
      // own clean pass — `openFromPass` answers `""` only for an `APPROVED`
      // record — so a non-blocking adversarial finding still gets its fixer and
      // its re-review like any other blocking one: it is a finding, and the bar
      // for whether the run may merge is decided by the lens verdict beside it.
      return cleanPass(review, rows, fixedFromLog(ctx.steps));
    }
    if (NO_FIX_VERDICTS.includes(review.verdict))
      throw new ReviewInfraError(
        `the six-lens review did not complete (${review.verdict}${review.note === undefined ? "" : `; disclosure: ${review.note}`}) — an incomplete round is not a pass to fix against`,
        rows,
      );

    // ── the one fix wave: a single fixer, given every blocking finding ────────
    // Both gates' outstanding findings go in one brief. A fixer handed half the
    // findings would be re-run by a second wave to be told the rest, and there is
    // no second wave: the wave is what the step buys, once.
    const blocking = review.findings;
    const findings = carried === "" ? blocking : [carried, blocking].join("\n\n");
    const gateName =
      carried === ""
        ? `six-lens review (${review.verdict})`
        : `adversarial pass and six-lens review (${review.verdict})`;
    const fix = await fixRound(deps, ctx, {
      head: review.head,
      frozen,
      findings,
      gate: gateName,
      wave: "full",
      arm: review.verdict === "APPROVED" ? "a" : "l",
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
    // The findings the wave was asked to answer, keyed by the review layer's own
    // row identities, so the re-review can say per finding whether it holds.
    const open = openFindings(review);

    // ── pass 2: the re-review, scoped to the fix range and nothing else ───────
    const reReview = await lensGate(deps, ctx, {
      base,
      branch,
      wave: "fix",
      pr,
      carried,
      since: preFixHead,
      rows,
      budget,
      threshold,
    });
    assertRan(reReview, rows);
    if (NO_FIX_VERDICTS.includes(reReview.verdict))
      throw new ReviewInfraError(
        `the re-review of the fix did not complete (${reReview.verdict}${reReview.note === undefined ? "" : `; disclosure: ${reReview.note}`}) — an incomplete round is not evidence that the fix answered anything`,
        rows,
      );
    // The adversarial gate's second pass runs AFTER the delta round it judges:
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

    const fates = classifyFates(open, reReview);
    const unresolved = fates.filter((f) => f.fate === "carried");
    if (unresolved.length > 0)
      throw new ReviewInfraError(
        `${CAUSE_NOT_ADDRESSED}: ${unresolved.map((f) => `${f.severity} ${f.id}`).join("; ").slice(0, 500)} — the fix wave ran, the re-review re-reported these blocking rows against the fixed head, and a second wave is not what a gate that repeated itself needs`,
        rows,
      );
    const introduced = fates.filter((f) => f.fate === "new-critical");
    if (introduced.length > 0)
      throw new ReviewInfraError(
        `${CAUSE_NEW_CRITICAL}: ${introduced.map((f) => `${f.severity} ${f.id}`).join("; ").slice(0, 500)} — the fix range itself holds a CRITICAL the full review did not report, and that is the fix's, not the branch's`,
        rows,
      );
    // A CRITICAL the report-only adversarial pass found in the fix range that the
    // lenses did not name is still a CRITICAL the fix introduced. The layer's own
    // CRITICAL verdict on the delta round, read from the pass whose range WAS the
    // fix, is the bar: a non-blocking pass (MINOR_OBSERVATIONS, or the findings it
    // carried onward) is disclosed and never ends the wave.
    if (reGate.findings !== "" && reGate.critical === true)
      throw new ReviewInfraError(
        `${CAUSE_NEW_CRITICAL}: the adversarial pass on the fix range reported a CRITICAL — ${reGate.findings.slice(0, 500)}`,
        rows,
      );
    // Everything blocking is answered and the fix introduced no CRITICAL. What the
    // re-review found that is neither — new rows below the bar, discounted
    // carries — is disclosed by the review layer's own residual post; it is never
    // a reason to buy another wave.
    return cleanPass(reReview, rows, true);
  } finally {
    // Scoped to THIS attempt's trees (issue, attempt, epoch) — see `closeFixTrees`.
    // An unscoped `-fix-` match tore down a concurrent attempt's live tree, which
    // is the case `test-lean-review-tree.ts` (w) now drives.
    await closeFixTrees(deps, ctx, attempt, runId);
  }
}

/**
 * The two shape claims a six-lens round must satisfy before its verdict means
 * anything, applied to BOTH passes.
 *
 * "A gate that did not run is never a gate that passed", enforced on the round
 * itself rather than only on the adversarial one: the review layer reports an
 * empty-delta round as `verdict: "APPROVED"` with no lens behind it (its own docs
 * say every consumer must branch on `noReview`), and a round whose lenses all died
 * reports no usage at all. Either one reaching a pass kind would tell the operator
 * the head was reviewed when the step paid for nobody to look at it. On the
 * re-review the empty-delta shape is unreachable for a legitimate reason — the
 * wave's own range was proven non-empty by `assertFixAdvanced` — which is why the
 * named no-change cause is raised where the wave is decided, and this stays the
 * backstop for a round that ran nobody.
 */
function assertRan(round: LensRound & { head: string }, rows: DispatchUsageRow[]): void {
  if (round.noReview === true)
    throw new ReviewInfraError(
      `the six-lens review ran no lens (nothing changed since the last recorded run${
        round.note === undefined ? "" : `: ${round.note}`
      }) — a head nobody re-reviewed is not a pass`,
      rows,
    );
  if (round.usage === undefined)
    throw new ReviewInfraError(
      `the six-lens review reported ${round.verdict} with no usage from any lens child — that is not a pass: ${round.findings.slice(0, 300)}`,
      rows,
    );
}

/**
 * The step's pass outcome: the kind, the reason, and the rows — bounded like
 * every other surface that reports rows.
 *
 * `DISPATCHES_MAX_ROWS` is the validator's own cap — `specify` clips its merged
 * rows with it, `errorOutcome.ts` clips the throw path, and an unbounded pass was
 * the one arm that could hand the engine a record the loader then rejects, which
 * does not report an over-long run: it drops the step's cost rows entirely,
 * silently under-billing the child that costs the most.
 *
 * **`fixed` or `done`.** The one fact the two kinds differ in is whether the fix
 * wave pushed commits; `passKind` reads that pair and says why the answer cannot
 * come from a variable alone (see `fixedFromLog`).
 *
 * The note a cleared round still owes: `finishLensReview` sets it ONLY on an
 * ISSUES_FOUND round whose disclosure post failed or could not be attempted, so
 * it cannot arrive on a clean verdict — but "cannot happen" is not a reason to
 * drop it, and a note carried into the step and read by nothing is the silent
 * version of the failure it reports. The merge guard's round-cap path refuses a
 * merge until the marker carrying these findings is on the PR
 * (`merge-guard-round-cap.ts`), so a note this step swallowed would cost the run
 * its ability to merge with nobody able to say why.
 */
function cleanPass(
  round: LensRound & { head: string },
  rows: DispatchUsageRow[],
  fixed: boolean,
): Outcome {
  const owed =
    round.note === undefined || round.note.trim() === "" ? "" : `; DISCLOSURE NOT POSTED: ${round.note}`;
  return {
    kind: passKind(fixed),
    reason: `adversarial and six-lens review clean at ${round.head.slice(0, 12)} (${fixed ? "one fix wave, re-reviewed" : "no blocking findings"})${owed}`,
    dispatches: rows.slice(-DISPATCHES_MAX_ROWS),
  };
}
