/**
 * lean/review-gates — the two gates as the `review` step calls them.
 *
 * `review.ts` is the decision procedure: which verdict ends the loop, what a fix
 * round is told, when the budget says stop. What lives here is the pair of
 * adapters between that loop and the two frozen review layers — one report-only
 * adversarial pass, one six-lens round — plus the judgement each one's *shape*
 * carries before any verdict is read: an adversarial pass with no verdict, a lens
 * round that ran no lens, a round that reported no usage from any child.
 *
 * Three rules both halves obey, and none is visible from the caller's side:
 *
 * - **The row each child cost is APPENDED to the caller's running total, never
 *   returned.** A copy handed back and re-assigned per round is how a handback
 *   ends up reporting the cost of one round as the cost of the step, and a total
 *   rebuilt each round reports a two-round run to the operator as a one-round one.
 * - **Absence is never a pass.** Each throws with the rows it paid for attached,
 *   because a gate that did not run is not a gate that approved and the run must
 *   hand back rather than carry an unreviewed head forward.
 * - **"Could not read" is never "clean".** `buildEvidence` and `runClaimScan`
 *   answer `undefined` / `[]` both for "found nothing" and for "the branch would
 *   not open" — so the precondition is established BEFORE them, by a read that
 *   does distinguish the two, and a failed read throws rather than reporting an
 *   empty scan. This is the same invariant `reviewedHead` enforces by refusing to
 *   return `""`; a lens round fed an evidence set nobody could read is a lens
 *   round that reviewed less than the ledger says it did.
 */

import { lensFixDelta } from "../fix-delta.ts";
import { buildEvidence, runClaimScan } from "../lens-evidence.ts";
import type { Severity } from "../lens-review-format.ts";
import { traceWarn } from "../trace.ts";
import type { AdversarialVerdictStatus } from "../types.ts";
import type { DispatchResult } from "../types.ts";
import type { HandlerCtx } from "./engine.ts";
import { lensContext } from "./review-deps.ts";
import { rangeDiff, reviewedHead } from "./review-git.ts";
import type { LensRound, ReviewDeps } from "./review.ts";
import { ReviewInfraError } from "./review.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { dispatchUsageRow, lensRows } from "./step-budget.ts";

/**
 * The status that alone means "nothing is outstanding", and the text the loop
 * writes when it passed with something still open. Both are constants of the
 * loop that produces them (`adversarial-verdict.ts`): its `passedRoundText` is
 * `clean ? "Adversarial APPROVED…" : "Adversarial PASSED WITH FINDINGS…"`, and
 * this step reads the same verdict object the loop did rather than guessing from
 * prose alone.
 */
const CLEAN_PASS: AdversarialVerdictStatus = "APPROVED";
const PASSED_WITH_FINDINGS_MARK = "PASSED WITH FINDINGS";

/**
 * What one report-only adversarial pass left open, and the step's own judgement
 * of whether that counts as a pass.
 *
 * `loopOutcome: "approved"` alone is NOT one. The loop reaches it from either
 * verdict (see `decideLoopAction` in `adversarial.ts`): a clean `APPROVED`, or a
 * non-blocking one it calls **PASSED WITH FINDINGS** — "these findings are
 * unresolved and travel to the PR body and the lens review". In the frozen
 * driver that carrying is a real act: `work-driver-adversarial.ts` puts the text
 * on the `adversarial-approved` event and `adversarial-findings.ts` renders it
 * into the PR body, and every one of the six lenses is told to judge it. Lean has
 * no PR body and no `commit-pr` step to hand them to, so the pass is read here
 * the same way and handed to the lens round by `lensContext`'s `carried` block —
 * which is the only reason that parameter exists.
 *
 * The status is read off `adversarialRounds` (#485: the loop's own per-round
 * records, threaded as data rather than recovered from prose), falling back to
 * the `PASSED WITH FINDINGS` marker only when a result carries no records — `""`
 * there means "no record to read", which is not a status an adversarial gate ever
 * approved with. A record whose status is anything but `APPROVED` is findings,
 * whatever `loopOutcome` was bucketed as: the records are what the loop judged
 * round by round, and the trailing record is the one that ended it.
 */
function openFromPass(result: DispatchResult): string {
  const records = result.adversarialRounds;
  const last = records === undefined ? undefined : records[records.length - 1];
  if (last !== undefined) return last.status === CLEAN_PASS ? "" : result.text;
  return result.text.includes(PASSED_WITH_FINDINGS_MARK) ? result.text : "";
}

/**
 * The role the adversarial gate's row carries.
 *
 * The loop does NOT report under `adversarial-developer` — that is the role of
 * the child it spawns. The result it hands back is synthesised
 * (`synthesizeResult` in `adversarial-verdict.ts`) and carries `role:
 * "adversarial-loop"`, the same string `headless/caps.ts` names. Billing the
 * step's most expensive child under the reviewer's role made lean's `byRole`
 * cost comparison against the frozen driver wrong: the driver records its
 * adversarial dispatches as `adversarial-loop` and lean recorded them as
 * something else, so the two columns never lined up. Asserted against the real
 * synthesised role here and in `test-lean-review-wiring.ts`, with the fixture's
 * default carrying the same value — a fixture and an assertion that both spell
 * the wrong role agree with each other and prove nothing.
 */
export const ADVERSARIAL_GATE_ROLE = "adversarial-loop";

/** What the adversarial gate hands the step: findings, or the budget's verdict. */
export type AdversarialGate =
  /**
   * A pass that reached a verdict. `findings` is the text it left open (`""` is
   * the clean pass); `critical` says whether the record that ended it was the
   * status doctrine calls blocking — the only reading of the gate's own prose
   * this step needs, and it is read off the loop's record rather than guessed
   * from the reply.
   */
  | { findings: string; critical: boolean; stop?: undefined }
  | { findings?: undefined; critical?: undefined; stop: BudgetFired };

/**
 * The adversarial gate: one report-only pass, and the finding text it left open.
 * `""` is the gate's clean pass. Anything else THROWS — a gate that produced no
 * verdict is not a gate that approved, and this one has no fixer of its own to
 * blame. The row this pass cost is APPENDED to the caller's running total, not
 * returned (see this file's header).
 *
 * `wave` names which half of the step's one wave this pass is, and it is what
 * puts the number in the reviewer's brief: the full review, or the re-review of
 * the fix diff. The loop's own `reportRound` is the display number the step
 * owns (`runAdversarialLoop` is entered once per wave, so the loop never runs
 * its own second round here), and the wave says what the reviewer is looking at
 * in words rather than as a position in a loop that no longer exists.
 */
export async function adversarialGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    head: string;
    branch: string;
    issueBody: string;
    /** Which pass of the one wave this is. */
    wave: "full" | "fix";
    /**
     * The findings the fix range was allowed to contain, for the re-review pass
     * only. Printed into the brief so the reviewer is told what counts as new
     * rather than left to re-litigate the whole branch.
     */
    blockingFindings?: string;
    rows: DispatchUsageRow[];
    /** The step's armed budget: the reviewer's bound, abort and progress hook. */
    budget: BudgetArms;
  },
): Promise<AdversarialGate> {
  let result: DispatchResult;
  try {
    result = await deps.adversarial({
      base: opts.base,
      head: opts.head,
      branch: opts.branch,
      cwd: ctx.repoRoot,
      issue: ctx.issue,
      issueBody: opts.issueBody,
      wave: opts.wave,
      ...(opts.blockingFindings === undefined ? {} : { blockingFindings: opts.blockingFindings }),
      headless: deps.headless,
      budget: opts.budget,
    });
  } catch (err) {
    throw new ReviewInfraError(
      `the adversarial loop threw: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  // The row is the LOOP's cost, under the role the loop actually reports —
  // `synthesizeResult`'s, not the inner reviewer's. See `ADVERSARIAL_GATE_ROLE`
  // for why attributing it to `adversarial-developer` made the per-role cost
  // comparison against the frozen driver wrong.
  const row = dispatchUsageRow(result);
  if (row.role !== ADVERSARIAL_GATE_ROLE)
    traceWarn(
      `lean review #${String(ctx.issue)}: the adversarial gate reported role ${JSON.stringify(row.role)}, not ${JSON.stringify(ADVERSARIAL_GATE_ROLE)} — the loop's synthesised role is what the run's cost record keys on`,
    );
  opts.rows.push(row);
  // The step's own ceiling ending the reviewer is a routed verdict, and it is
  // read FIRST: a stopped child has no verdict, and the arm below would otherwise
  // report the operator's budget as "the gate produced no verdict" — infrastructure
  // for something that was a decision the operator made.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) return { stop: fired };
  if (result.loopOutcome === "approved") return { findings: openFromPass(result), critical: false };
  if (result.loopOutcome === "rejected") {
    // A real `VERDICT:` line is what makes a rejection a VERDICT. `parseVerdict`
    // defaults the status when the reviewer's reply holds no marker, and the
    // report-only loop returns that defaulted record verbatim; reading it as
    // "the findings the loop refuses to clear" would let the step spend its one
    // fix wave on prose that was never a judgement, and then hand back that same
    // prose as "a blocking finding the fix did not address". A round the loop
    // could not parse leaves `verdictParsed` false (or carries no record at all),
    // and this gate has no fixer of its own to blame — it is the same
    // "no verdict is not a pass" the no-verdict arm below already refuses, read
    // off the records the loop judged rather than guessed from the reply.
    const lastRecord = result.adversarialRounds?.[result.adversarialRounds.length - 1];
    if (lastRecord !== undefined && lastRecord.verdictParsed !== true)
      throw new ReviewInfraError(
        `the adversarial gate returned no readable VERDICT marker on its reviewed round (status ${String(lastRecord.status)} defaulted) — findings that were never a verdict cannot be fixed against: ${result.text.slice(0, 300)}`,
        opts.rows,
      );
    return { findings: result.text, critical: blockingPass(result) };
  }
  throw new ReviewInfraError(
    `the adversarial gate produced no verdict (${String(result.loopOutcome)}${
      result.killCause === undefined ? "" : `, killed: ${String(result.killCause)}`
    }) — that is not a pass: ${result.text.slice(0, 300)}`,
    opts.rows,
  );
}

/**
 * Did the record that ended this pass say the word doctrine calls blocking?
 *
 * `runAdversarialLoop` in report-only mode returns after its FIRST reviewed
 * round, so `adversarialRounds` holds exactly the record it judged (the loop's
 * own `#485` comment: these are what it judged round by round, not prose to
 * guess from). `loopOutcome: "rejected"` is bucketed from that one record, so
 * reading `CRITICAL_ISSUES_FOUND` off it is reading the loop's own answer — the
 * one thing the step needs to tell "the fix introduced a CRITICAL" apart from a
 * pass with findings still disclosable. No record, or a record whose status was
 * defaulted, is not a CRITICAL: an unreadable reply is never evidence of the
 * most serious finding there is.
 */
function blockingPass(result: DispatchResult): boolean {
  const records = result.adversarialRounds;
  const last = records === undefined ? undefined : records[records.length - 1];
  return last?.verdictParsed === true && last.status === "CRITICAL_ISSUES_FOUND";
}

/**
 * The six-lens gate: one round at the commit the adversarial gate just cleared.
 *
 * Its own read of origin, deliberately, rather than the value the caller still
 * holds: if the pass before left origin somewhere else, that is the fact the
 * next verdict should be stated against. Two gates reviewing two different
 * commits have reviewed neither.
 *
 * **The re-review's range is the caller's, not the layer's.** With `since` set,
 * the round reviews `git diff <since>..<head>` — the fix wave's own commits, and
 * nothing else. Without it, the layer derives its own delta base from the lens
 * ledger (the head of the last RECORDED run), which is a different question: the
 * step would be certifying a range it did not choose, and a head the step's own
 * fixer moved would be re-reviewed against whatever the ledger last saw. The
 * step always names `since` on the fix pass and never on the full one, so the
 * full round stays the layer's ordinary whole-branch review.
 *
 * The diff is read ONCE and handed to the evidence builders, which take it as a
 * parameter. They do not need their own read of it and did not have one; what
 * they need from the caller is the guarantee that the branch opened at all, which
 * a successful diff read establishes. Before this the round paid for the range
 * three times over and passed none of it down.
 */
export async function lensGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    branch: string;
    /** Which pass of the one wave this round is (see `adversarialGate`). */
    wave: "full" | "fix";
    /** The run's PR number, threaded to the review layer rather than re-derived. */
    pr: number | undefined;
    carried: string | undefined;
    /** The lower bound of this round's range — set only on the re-review. */
    since?: string;
    rows: DispatchUsageRow[];
    /** The step's armed budget, threaded to the six lens children. */
    budget: BudgetArms;
    /** The project's blocking severity, resolved once by the step and threaded
     * to the review layer so the verdict, the ledger row and the step's decision
     * to buy a fixer all read one bar. */
    threshold: Severity;
  },
): Promise<LensRound & { head: string }> {
  const head = await reviewedHead(deps, ctx.repoRoot, opts.branch, opts.rows);
  // The range the round RANGES over. On the re-review the lower bound is the
  // head the fix wave started from, so the evidence, the claim scan and the
  // lenses all read the fix rather than the whole branch: a lens handed the
  // full `base...head` diff on the re-review re-reports findings the full review
  // already raised, and the step would read its own earlier findings back as
  // "NOT ADDRESSED". `since` is a commit, so the range is two-dot on purpose —
  // the fix's commits are the delta, not a merge-base story.
  const rangeBase = opts.since ?? opts.base;
  // Throws on a range it could not read, so everything below runs only on a
  // branch this step has positively opened.
  const diff = await rangeDiff(deps, ctx.repoRoot, rangeBase, head, opts.rows);
  // `rangeDiff` throws rather than returning empty, so a missing diff never gets
  // here — but the type says `string | undefined` because the read itself can
  // fail, and nothing below may receive an `undefined` it would read as "an empty
  // diff". Restated rather than asserted so a future change to `rangeDiff`'s
  // contract has to pass this gate again.
  if (diff === undefined)
    throw new ReviewInfraError(
      `could not read the diff ${rangeBase.slice(0, 12)}...${head.slice(0, 12)} for the six-lens pass`,
      opts.rows,
    );
  // What the last fix pass moved, so a lens reads the delta first and weighs it
  // specifically for what the fix broke beside the line it repaired. The step
  // passes NO `since`: `lensFixDelta` resolves the current pushed head itself and
  // `lens-review-diff.ts` derives its own `since` from the lens ledger when the
  // caller gives it none, so there is no second source for that value to
  // duplicate — the deleted parameter here was one, and a dead parameter is a
  // liability rather than a saving.
  const delta = await lensFixDelta(ctx.repoRoot, opts.branch, undefined);
  // Both read the BRANCH, not `head`: each builds an `origin/<branch>` ref
  // internally (`lens-evidence.ts`, `work-driver-diff.ts`), and `head` is a
  // resolved 40-hex sha, so `origin/<sha>` is a ref that cannot exist. Every
  // failure inside them is swallowed, so passing the sha does not throw — it
  // silently reports "no claims to check, no prose to supply", which is the same
  // shape as a clean scan. That is exactly why `diff` above is read first and
  // throws rather than returning empty: it is the one call in this sequence that
  // can tell "nothing to say" from "could not look". Same reason the frozen driver
  // passes `ps.branchName` (work-driver-lens.ts:158-165). `head` stays what the
  // review RANGES over; the branch is what these two read ON.
  const evidence = await buildEvidence(ctx.repoRoot, opts.branch, diff);
  const extraFindings = await runClaimScan(deps.exec, ctx.repoRoot, opts.branch, diff);
  let round: LensRound;
  try {
    round = await deps.lens({
      base: opts.base,
      head,
      branch: opts.branch,
      cwd: ctx.repoRoot,
      wave: opts.wave,
      pr: opts.pr,
      context: lensContext(ctx.issue, opts.wave, {
        carried: opts.carried,
        fixDelta: delta.section,
      }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      evidence,
      extraFindings,
      headless: deps.headless,
      budget: opts.budget,
      threshold: opts.threshold,
    });
  } catch (err) {
    throw new ReviewInfraError(
      `the six-lens review threw: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  // One row per lens child that ran, not one for the round — see `lensRows`.
  opts.rows.push(...lensRows(round.lenses));
  return { ...round, head };
}
