/**
 * lean/review — the run's gate: the adversarial loop, the six-lens pass, and a
 * bounded number of fix rounds between them.
 *
 * Both gates are the frozen driver's own code, called rather than copied:
 * `runAdversarialLoop` in report-only mode (it reviews and fixes nothing; this
 * step routes its verdict) and `runLensReview` for the six lenses. What is
 * lean's own is which tree they read, who fixes what they find, and when the
 * loop stops. Where the bytes are and how they move is `review-git.ts` and
 * `review-tree.ts`; the shapes the two gates are called with are
 * `review-args.ts`; what the step says about its own cost is `review-step.ts`;
 * this file is the decision procedure.
 *
 * **Both gates read a resolved commit, never a working copy.** A gate approves
 * the bytes at a commit, and the only value that cannot be dirtied underneath
 * the step between two rounds is a commit sha resolved from a ref. This step
 * resolves origin's branch once per round and hands the same value to both
 * gates, to the fixer, and to the integration — five uses of one commit cannot
 * disagree, and a working copy would give each of them a different tree. Both
 * gates therefore get a ref range they compute their own diff from rather than
 * a string this step pasted: a pasted diff is a value the reviewer cannot
 * re-read, and a range is one it can.
 *
 * **The fix runs in a disposable tree of its own** (the tree lifecycle is in
 * `review-tree.ts`, the round in `review-git.ts`), detached at the reviewed
 * commit and destroyed at the end of the round — because the fixer must not
 * touch the tree `verify` and `publish` read. A child loose in the run's
 * worktree between two gates would leave the green verdict describing one
 * commit and the PR holding another. Detached on
 * purpose: a fixer that commits there moves no branch, so a child that committed
 * twice, amended, or reset could not corrupt what the run merges. Only the
 * integration moves anything, and only after its claims hold.
 *
 * **Two bounds, two jobs** (see `MAX_REVIEW_ROUNDS` for the one statement of
 * how they interact). The round count is a module constant; `budgets.review`
 * in `.pi/work.json` is the money, armed on every child the step dispatches
 * through the same `armBudget` the other three dispatching steps use.
 *
 * **What ends the step.** Both gates clean ends it, on one of two kinds that
 * differ only in what the step did to the branch: `done` when no fix round ran and
 * the run goes to `ci`, or `fixed` when a fix round pushed commits and the run
 * must re-verify the head it now has. Which of the two is read from the durable
 * log, not from a variable — see `fixedFromLog` in `review-log.ts` for why a
 * closure cannot answer that question for a resumed attempt.
 *
 * Anything else THROWS: findings still open at the bound, a gate that produced
 * no verdict, a head that moved or vanished mid-round, a fix round that changed
 * nothing, a fixer that rewrote the frozen contract, an integration that could
 * not be proven — and a child the operator's budget stopped. A throw is the
 * engine's infrastructure path — the run hands back at exit 10 with the cause
 * named, rather than carrying an unreviewed head forward on a pass it did not
 * earn. A gate that did not run is never a gate that passed.
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
import type { Finding } from "../lens-review-types.ts";
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
import { assertFixAdvanced, stagnantAgainstFix } from "./review-progress.ts";
import { budgetStopped, passKind } from "./review-step.ts";
import { closeFixTrees } from "./review-tree.ts";
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
  FixRunId,
  LensArgs,
  LensRound,
  ReviewDeps,
} from "./review-args.ts";
import type { ReviewDeps } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import type { Outcome } from "./state.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { armBudget, budgetFor } from "./step-budget.ts";

/**
 * How many fix rounds this step will pay for. A module constant, not an
 * operator knob: the only lean knob stays whether lean may merge.
 *
 * **How this constant and `budgets.review` interact — the one place it is
 * stated.** The constant bounds the ROUNDS (reviewer + six lenses + fixer), and
 * the budget bounds the MONEY. They are never divided into each other. Deriving
 * the round cap from the turn budget (`turns / TURNS_PER_ROUND`) shipped a
 * default budget a `max(1, 150/300)` = **one round**, and one round can
 * fix but can never re-review — so the step certified a head no gate had looked
 * at since its own fixer moved it. That is the defect this constant closes. The
 * budget stays fully live and stays the stop condition the operator owns: it is
 * armed on every child through `armBudget`. A child that spends it is NOT a
 * routed verdict the way `build`/`challenge`/`specify` route theirs — this step
 * has no `budget` arrow to route on, so the stop throws with the rows it paid for
 * (see this file's header for why the two shapes differ).
 */
export const MAX_REVIEW_ROUNDS = 3;

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

/** The `review` step. Returns `done` or a routed budget verdict; THROWS on anything else. */
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
  // a step that discovered its spec was unreadable after two rounds of review
  // had spent those rounds for nothing.
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
  // step needs before it pays for a round, and a step that discovered its bar was
  // unreadable after two rounds would have spent those rounds at the wrong one.
  // Never per round — see `ReviewDeps.reviewThreshold`.
  const threshold = await deps.reviewThreshold(repoRoot, base).catch((err: unknown) => {
    throw new ReviewInfraError(
      `could not resolve the project's review threshold: ${(err as Error).message}`,
    );
  });

  // The step's disposable trees are named once per attempt, so every round of a
  // resumed run re-enters the paths its crashed self left (see `fixRunId`).
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
  // progress passes it) — it never bounded the ROUND count, which is
  // `MAX_REVIEW_ROUNDS` alone. Naming the number here says only what it bounds, so
  // an operator raising `turns` is not led to expect more rounds (see
  // `MAX_REVIEW_ROUNDS` for the one statement of how the two interact).
  const turnCap = budgetFor(config, "review")?.turns ?? 0;

  // `rows` accumulates across the WHOLE step, not one round: the handback must
  // say what every round cost, including the one that failed. Nothing re-derives
  // it per round — a total rebuilt each round reports a two-round run to the
  // operator as a one-round one.
  const rows: DispatchUsageRow[] = [];
  let head = await reviewedHead(deps, repoRoot, branch, rows);
  // This attempt's number, from the log the engine resumes off — see
  // `reviewAttemptFromLog`. It is part of every fix tree's name, so it is read
  // once here rather than derived per round.
  const attempt = reviewAttemptFromLog(ctx.steps);
  /**
   * Findings the adversarial gate passed on without blocking, for the lenses to
   * weigh. Set on the pass-with-findings arm and read on the lens arm — the arm
   * that consumes them is the next round's, because the findings arm fixes first
   * and comes back around, so the assignment must survive the `continue`.
   */
  let carried: string | undefined;
  /**
   * What the LAST fix round was asked to fix, and the head it started from.
   *
   * The tie-breaker the loop otherwise has none of. `MAX_REVIEW_ROUNDS` bounds
   * the fixer, and `assertFixAdvanced` refuses a fixer that fixed nothing — but
   * neither sees the case where the fixer DID land a commit and the gate that
   * asked for it comes back with the identical findings anyway. That is not a
   * reviewer being stubborn, it is a deterministic gate: `adversarialGate` reads
   * the head it was handed and re-reports what it saw, and a finding it did not
   * fix (out of scope, or unfisable without touching a frozen test, which the
   * fixer's brief tells it to leave alone) recurs verbatim. Measured: a run whose
   * fixer commits on every round and whose adversarial gate always returns one
   * finding dispatched fixers forever — the round counter incremented, but the
   * round guard lived on the LENS arm only, so nothing bounded the adversarial arm
   * at all. That guard now sits at the top of the loop body where both arms pass
   * it — the bound is what stops a gate that merely never stops talking — and this
   * tie-breaker is what fires EARLIER, on the gate that says the same thing twice.
   *
   * So: if a fix round moved the head and the SAME gate then reported the SAME
   * findings against the new head, the loop is not making progress and the next
   * round will not either. Hand back with the findings, rather than buying them.
   */
  let lastFix: { gate: string; findings: string; from: string } | undefined;
  /**
   * The findings the loop is still trying to answer, for the round bound's cause
   * line. Read lazily — the bound check runs before any gate has spoken, and
   * `lastFix` is the request the LAST fix round was handed, so it still names what
   * is outstanding on the arm that moved the head without recording `carried` (the
   * lens arm). Never a guess about what a gate would have said.
   */
  const openFindings = (): string => carried ?? lastFix?.findings ?? "";

  /**
   * How many fix rounds THIS visit integrated, counted as they land. A round
   * reaches the increment only past `assertFixAdvanced`, and `integrate` throws on
   * every path that did not push — so this counter and "the branch moved" are the
   * same fact, held by the code that observed it.
   *
   * It is the step's own answer, and the one the reason line prints. The pass at
   * the end of the loop ORs it with {@link fixedFromLog}, which is the same
   * question asked of the durable record: the only case the counter cannot answer
   * is the resume, where the attempt that pushed is gone and origin kept its head.
   */
  let fixRounds = 0;

  try {
    for (let round = 1; ; round++) {
      // **THE ROUND BOUND, ON BOTH ARMS, BEFORE ANY CHILD IS PAID.** This guard
      // used to live below, inside the lens arm only, so the adversarial arm
      // reached `fixRound` without ever passing it: a gate that kept returning
      // findings looped forever, each pass buying a reviewer AND a fixer. The same
      // loop measured on the lens arm — which did have a guard, and still ran away
      // once — reached **550 fix rounds in 90 seconds**, every one a paid child.
      // It sits here, at the top of the body before `adversarialGate`, rather than
      // as a second copy beside the first: two copies of one bound are two answers
      // to "how many rounds may this step buy", and the arm that had none is what
      // made the other arm's copy a lie about the step.
      if (round > MAX_REVIEW_ROUNDS)
        throw new ReviewInfraError(
          `the review loop reached round ${String(round)} at the step's bound of ${String(MAX_REVIEW_ROUNDS)} rounds (the per-child turns ceiling was ${String(turnCap)}) — a gate that keeps returning findings is not a gate a fix round will satisfy: ${openFindings().slice(0, 500)}`,
          rows,
        );
      const gate = await adversarialGate(deps, ctx, {
        base,
        head,
        branch,
        issueBody,
        round,
        rows,
        budget,
      });
      // The operator's ceiling stopping this step is read BEFORE the gate's own
      // infra throw could mistake a stopped reviewer for "no verdict at all", and
      // it THROWS: the table has one arrow out of `review` and it is a clean pass.
      if (gate.stop !== undefined) throw budgetStopped(gate.stop, rows);

      if (gate.findings !== "") {
        carried = gate.findings;
        const fix = await fixRound(deps, ctx, {
          head,
          frozen,
          findings: gate.findings,
          gate: "adversarial loop",
          round,
          arm: "a",
          attempt,
          runId,
          rows,
          budget,
        });
        if (fix.stop !== undefined) throw budgetStopped(fix.stop, rows);
        // The stagnation check reads what the fix round was asked for, so it is
        // recorded before the head moves: after the move, the round's own request
        // is no longer recoverable and the comparison would be against nothing.
        const requested = {
          gate: "adversarial loop",
          findings: gate.findings,
          from: head,
        };
        head = await assertFixAdvanced(head, fix.head, rows);
        fixRounds++;
        // Same gate, same findings, a head that moved: the fixer answered the
        // round and the gate did not move. One more round buys the same reply.
        if (stagnantAgainstFix(lastFix, requested, head))
          throw new ReviewInfraError(
            `the adversarial loop reported the same findings again after the fix round moved the head to ${head.slice(0, 12)} — a deterministic gate re-reporting what it already saw is not progress, and the findings are: ${gate.findings.slice(0, 500)}`,
            rows,
          );
        lastFix = requested;
        continue;
      }

      const lens = await lensGate(deps, ctx, {
        base,
        branch,
        round,
        pr,
        carried,
        rows,
        budget,
        threshold,
      });
      // "A gate that did not run is never a gate that passed", enforced on the
      // lens round itself rather than only on the adversarial one: the review
      // layer reports an empty-delta round as `verdict: "APPROVED"` with no lens
      // behind it (its own docs say every consumer must branch on `noReview`),
      // and a round whose lenses all died reports no usage at all. Either one
      // reaching `done` would tell the operator the head was reviewed when the
      // step paid for nobody to look at it.
      if (lens.noReview === true)
        throw new ReviewInfraError(
          `the six-lens review ran no lens (nothing changed since the last recorded run${
            lens.note === undefined ? "" : `: ${lens.note}`
          }) — a head nobody re-reviewed is not a pass`,
          rows,
        );
      if (lens.usage === undefined)
        throw new ReviewInfraError(
          `the six-lens review reported ${lens.verdict} with no usage from any lens child — that is not a pass: ${lens.findings.slice(0, 300)}`,
          rows,
        );
      if (lens.verdict === "APPROVED") {
        // The note a cleared round still owes. `finishLensReview` sets it ONLY on
        // an ISSUES_FOUND round whose disclosure post failed or could not be
        // attempted, so it cannot arrive on this verdict — but "cannot happen" is
        // not a reason to drop it, and a note carried into the step and read by
        // nothing is the silent version of the failure it reports. The merge
        // guard's round-cap path refuses a merge until the marker carrying these
        // findings is on the PR (condition 5, `merge-guard-round-cap.ts`), so a
        // note this step swallowed would cost the run its ability to merge with
        // nobody able to say why. Inlined here rather than kept in a loop-external
        // `disclosure` variable that only ever had this one reader.
        const owed =
          lens.note === undefined || lens.note.trim() === ""
            ? ""
            : `; DISCLOSURE NOT POSTED: ${lens.note}`;
        // The success path is BOUNDED like every other surface that reports rows.
        // `DISPATCHES_MAX_ROWS` is the validator's own cap — `specify` clips its
        // merged rows with it and `error-outcome.ts` clips the throw path, and an
        // unbounded pass was the one arm that could hand the engine a record the
        // loader then rejects, which does not report an over-long run: it drops
        // the step's cost rows entirely, silently under-billing the child that
        // costs the most.
        //
        // **`fixed` or `done`.** The one fact the two kinds differ in is whether
        // a fix round pushed commits; `passKind` reads that pair and says why the
        // answer cannot come from the loop's count alone.
        const fixed = fixRounds > 0 || fixedFromLog(ctx.steps);
        return {
          kind: passKind(fixed),
          reason: `adversarial and six-lens review clean at ${lens.head.slice(0, 12)} (${String(round)} round(s)${
            fixed ? `, ${String(fixRounds)} with a fix round` : ""
          })${owed}`,
          dispatches: rows.slice(-DISPATCHES_MAX_ROWS),
        };
      }
      if (NO_FIX_VERDICTS.includes(lens.verdict))
        throw new ReviewInfraError(
          `the six-lens review did not complete (${lens.verdict}${lens.note === undefined ? "" : `; disclosure: ${lens.note}`}) — an incomplete round is not a pass to fix against`,
          rows,
        );
      // The bound that decides whether THIS round may buy a fixer is the loop-head
      // guard above, which both arms pass. It reads `round > MAX_REVIEW_ROUNDS`
      // because round `MAX_REVIEW_ROUNDS` is still allowed to review; reaching
      // here therefore means a fixer is still affordable, and no second copy of
      // the check sits beside the first — the arm that had none WAS the bug.
      const fix = await fixRound(deps, ctx, {
        head: lens.head,
        frozen,
        findings: lens.findings,
        gate: `six-lens review (${lens.verdict})`,
        round,
        arm: "l",
        attempt,
        runId,
        rows,
        budget,
      });
      if (fix.stop !== undefined) throw budgetStopped(fix.stop, rows);
      const lensRequested = {
        gate: `six-lens review (${lens.verdict})`,
        findings: lens.findings,
        from: lens.head,
      };
      head = await assertFixAdvanced(lens.head, fix.head, rows);
      fixRounds++;
      if (stagnantAgainstFix(lastFix, lensRequested, head))
        throw new ReviewInfraError(
          `the six-lens review reported the same findings again after the fix round moved the head to ${head.slice(0, 12)} — the findings are: ${lens.findings.slice(0, 500)}`,
          rows,
        );
      lastFix = lensRequested;
    }
  } finally {
    // Scoped to THIS attempt's trees (issue, attempt, epoch) — see `closeFixTrees`.
    // An unscoped `-fix-` match tore down a concurrent attempt's live tree, which
    // is the case `test-lean-review-tree.ts` (w) now drives.
    await closeFixTrees(deps, ctx, attempt, runId);
  }
}
