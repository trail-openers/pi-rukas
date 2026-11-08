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
 *   does distinguish the two. This is the same invariant `reviewedHead` enforces
 *   by refusing to return `""`.
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
 * writes when it passed with something still open. Both are constants of
 * `adversarial-verdict.ts`, whose `passedRoundText` produces the marker; this step
 * reads the same verdict object the loop did rather than guessing from prose.
 */
const CLEAN_PASS: AdversarialVerdictStatus = "APPROVED";
const PASSED_WITH_FINDINGS_MARK = "PASSED WITH FINDINGS";

/**
 * The adversarial statuses that block, per the role's own doctrine, which calls
 * exactly one verdict "Must fix before proceeding". Spelled as an allowlist so a
 * fifth status added to `AdversarialVerdictStatus` is non-blocking until someone
 * classifies it here — the safe direction for a step that spends a child, a
 * re-review and a second gate pass on whatever it reads as blocking.
 */
const BLOCKING_ADVERSARIAL_STATUSES: readonly AdversarialVerdictStatus[] = [
  "CRITICAL_ISSUES_FOUND",
];

/** The record that ended the pass, or `undefined` when the loop carried none. */
function lastRound(result: DispatchResult) {
  const records = result.adversarialRounds;
  return records === undefined ? undefined : records[records.length - 1];
}

/**
 * Did the record that ended this pass carry a blocking status?
 *
 * No record, or a record whose status was DEFAULTED (no readable `VERDICT:`
 * marker), is not a blocking finding: an unreadable reply is never evidence for
 * the most serious verdict there is, and the step refuses it as "no verdict"
 * before any fixer is bought.
 */
function blockingRecord(result: DispatchResult): boolean {
  const last = lastRound(result);
  return last?.verdictParsed === true && BLOCKING_ADVERSARIAL_STATUSES.includes(last.status);
}

/**
 * What one report-only adversarial pass left open, and whether the step may buy
 * a fix wave with it.
 *
 * `loopOutcome: "approved"` alone is NOT a clean pass: the loop reaches it from
 * either a clean `APPROVED` or a non-blocking verdict whose findings travel to the
 * PR body and the lens review. Lean has no PR body and no `commit-pr` step to hand
 * them to, so the pass is read here and handed to the lens round by `lensContext`'s
 * `carried` block — the only reason that parameter exists.
 *
 * `open` and `blocking` are two answers, not one question. `open` — findings the
 * lenses must judge and the disclosure must carry — is true for any reported row;
 * `blocking` — the wave's price of admission — only for the status doctrine calls
 * blocking. A pass open and not blocking is a reviewer that reported findings it
 * declined to stop the run for, and paying for a fixer, a re-review and a second
 * gate pass against those is the deviation this split closes.
 *
 * Both are read off `adversarialRounds` — the loop's own per-round records, threaded
 * as data rather than recovered from prose — falling back to the
 * `PASSED WITH FINDINGS` marker only when a result carries no records. A record
 * whose status is anything but `APPROVED` is findings, whatever `loopOutcome` was
 * bucketed as: the records are what the loop judged round by round.
 */
function openFromPass(result: DispatchResult): { findings: string; open: boolean } {
  const last = lastRound(result);
  if (last !== undefined) {
    // A record the loop could not parse held no VERDICT marker, so nothing in it
    // was judged: its text still travels to the lenses, but it is not a status
    // that blocks — and the `rejected` arm refuses an unparsed record outright.
    return {
      findings: last.status === CLEAN_PASS ? "" : result.text,
      open: last.verdictParsed === true && last.status !== CLEAN_PASS,
    };
  }
  const carried = result.text.includes(PASSED_WITH_FINDINGS_MARK);
  return { findings: carried ? result.text : "", open: carried };
}

/**
 * The role the adversarial gate's row carries: the role the loop itself reports
 * under, not the inner reviewer's role. Billing the step's most expensive child
 * under the reviewer's role made lean's `byRole` cost comparison against the
 * frozen driver wrong, since the driver records these as `adversarial-loop`.
 * Asserted here and in `test-lean-review-wiring.ts` against the real synthesised
 * role — a fixture and an assertion that both spell the wrong role agree with each
 * other and prove nothing.
 */
export const ADVERSARIAL_GATE_ROLE = "adversarial-loop";

/** What the adversarial gate hands the step: findings, or the budget's verdict. */
export type AdversarialGate =
  /**
   * A pass that reached a verdict. `findings` is the text it left open (`""` is
   * the clean pass); `open` says findings were reported and `blocking` whether the
   * record that ended the pass carried the status doctrine calls blocking. A pass
   * can be `open` without being `blocking`: that is what a non-blocking verdict is,
   * and its findings are disclosed, never fixed.
   */
  | { findings: string; open: boolean; blocking: boolean; stop?: undefined }
  | { findings?: undefined; open?: undefined; blocking?: undefined; stop: BudgetFired };

/**
 * The adversarial gate: one report-only pass, and the finding text it left open.
 * `""` is the gate's clean pass. Anything else THROWS — a gate that produced no
 * verdict is not a gate that approved, and this one has no fixer of its own to
 * blame. The row this pass cost is APPENDED to the caller's running total, not
 * returned (see this file's header).
 *
 * `wave` names which half of the step's one wave this pass is, and puts the number
 * in the reviewer's brief: the full review, or the re-review of the fix diff. The
 * wave says what the reviewer is looking at in words rather than as a position in a
 * loop that no longer exists.
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
  // The row is the LOOP's cost, under the role the loop actually reports — see
  // `ADVERSARIAL_GATE_ROLE`.
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
  if (result.loopOutcome === "approved") {
    const pass = openFromPass(result);
    return { ...pass, blocking: blockingRecord(result) };
  }
  if (result.loopOutcome === "rejected") {
    // A real `VERDICT:` line is what makes a rejection a VERDICT: `parseVerdict`
    // defaults the status when the reply holds no marker, and reading that default
    // as "findings the loop refuses to clear" would spend the one fix wave on prose
    // that was never a judgement. So BOTH shapes of "nothing was judged" are refused
    // here — no record at all, and an unparsed trailing record. This gate has no
    // fixer of its own to blame, which is why it throws rather than routing.
    const lastRecord = result.adversarialRounds?.[result.adversarialRounds.length - 1];
    if (lastRecord === undefined || lastRecord.verdictParsed !== true)
      throw new ReviewInfraError(
        `the adversarial gate returned a rejection with ${
          lastRecord === undefined
            ? "no reviewed round to read a verdict from"
            : `no readable VERDICT marker on its reviewed round (status ${String(lastRecord.status)} defaulted)`
        } — findings that were never a verdict cannot be fixed against: ${result.text.slice(0, 300)}`,
        opts.rows,
      );
    // One shape is still incoherent: a `rejected` outcome whose parsed record says
    // `APPROVED` is a loop that refused a run it also certified, and no reading is
    // safe — the step would either buy a fixer for an approval or clear a head the
    // loop rejected. Refused in the direction of the blast radius.
    if (lastRecord.status === CLEAN_PASS)
      throw new ReviewInfraError(
        `the adversarial gate's outcome says rejected but its own trailing record reads ${CLEAN_PASS} — the loop rejected a head it also approved, and neither reading can be acted on: ${result.text.slice(0, 300)}`,
        opts.rows,
      );
    // Its findings are open, and blocking only if its status says so.
    return { findings: result.text, open: true, blocking: blockingRecord(result) };
  }
  throw new ReviewInfraError(
    `the adversarial gate produced no verdict (${String(result.loopOutcome)}${
      result.killCause === undefined ? "" : `, killed: ${String(result.killCause)}`
    }) — that is not a pass: ${result.text.slice(0, 300)}`,
    opts.rows,
  );
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
 * nothing else. Without it the layer derives its own delta base from the lens
 * ledger, so the step would be certifying a range it did not choose. The step
 * always names `since` on the fix pass and never on the full one.
 *
 * The diff is read ONCE and handed to the evidence builders as a parameter; what
 * they need from the caller is the guarantee that the branch opened at all, which a
 * successful diff read establishes.
 */
export async function lensGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    branch: string;
    /** Which pass of the one wave this round is (see `adversarialGate`). */
    wave: "full" | "fix";
    /** The run's issue body, printed into the lens brief by `lensContext` below.
     * The lens seam itself takes no body — the context string is what the six
     * children read. */
    issueBody: string;
    /** The run's PR number, threaded to the review layer rather than re-derived. */
    pr: number | undefined;
    carried: string | undefined;
    /** The lower bound of this round's range — set only on the re-review. */
    since?: string;
    /** Buy the layer's whole-branch round on the fix wave (see `LensArgs.full`), and
     * reach the lenses' brief so its range wording names the arm they judge. */
    full?: boolean;
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
  // The diff is read from the REPO ROOT, not the round's worktree: `rangeDiff`
  // needs only the object database and the two commits, and the repo root is the
  // one directory this step knows is present for the whole step — the run's own
  // worktree may be gone by the re-review, and a diff read whose cwd has been
  // deleted reports "could not read" for a range git resolves fine. The evidence
  // builders below still read the BRANCH.
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
  // for what the fix broke beside the line it repaired. The step passes NO `since`:
  // `lensFixDelta` resolves the pushed head itself and the diff layer derives its
  // own `since` from the lens ledger when given none, so there is no second source
  // to duplicate.
  const delta = await lensFixDelta(ctx.repoRoot, opts.branch, undefined);
  // Both read the BRANCH, not `head`: each builds an `origin/<branch>` ref
  // internally, and `head` is a resolved sha, so `origin/<sha>` cannot exist. Every
  // failure inside them is swallowed, so passing the sha silently reports "no claims
  // to check" — the same shape as a clean scan. That is why `diff` above is read
  // first and throws rather than returning empty: it is the one call that can tell
  // "nothing to say" from "could not look".
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
      // The run's issue reaches the six lens children inside `context`: the lens
      // seam takes no separate body field (see `LensArgs.context`).
      context: lensContext(ctx.issue, opts.wave, {
        carried: opts.carried,
        fixDelta: delta.section,
        // The arm's own range claim, so the brief's wording follows what the step bought
        // rather than the delta section, which `lensFixDelta` reads on both arms.
        full: opts.full,
        issueBody: opts.issueBody,
      }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.full === true ? { full: true } : {}),
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
