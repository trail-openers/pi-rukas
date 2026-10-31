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
 * Two rules both halves obey, and neither is visible from the caller's side:
 *
 * - **The row each child cost is APPENDED to the caller's running total, never
 *   returned.** A copy handed back and re-assigned per round is how a handback
 *   ends up reporting the cost of one round as the cost of the step, and a total
 *   rebuilt each round reports a two-round run to the operator as a one-round one.
 * - **Absence is never a pass.** Each throws with the rows it paid for attached,
 *   because a gate that did not run is not a gate that approved and the run must
 *   hand back rather than carry an unreviewed head forward.
 */

import { lensFixDelta } from "../fix-delta.ts";
import { buildEvidence, runClaimScan } from "../lens-evidence.ts";
import type { AdversarialVerdictStatus } from "../types.ts";
import type { DispatchResult } from "../types.ts";
import type { HandlerCtx } from "./engine.ts";
import { rangeDiff, reviewedHead } from "./review-git.ts";
import { lensContext } from "./review-prompt.ts";
import { lensRows } from "./review-tree.ts";
import type { LensRound, ReviewDeps } from "./review.ts";
import { ReviewInfraError } from "./review.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { dispatchUsageRow } from "./step-budget.ts";

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
 * the `PASSED WITH FINDINGS` marker only when a result carries no records —
 * `""` there means "no record to read", which is not a status an adversarial
 * gate ever approved with.
 */
function openFromPass(result: DispatchResult): string {
  const records = result.adversarialRounds;
  const last = records === undefined ? undefined : records[records.length - 1];
  if (last !== undefined) return last.status === CLEAN_PASS ? "" : result.text;
  return result.text.includes(PASSED_WITH_FINDINGS_MARK) ? result.text : "";
}

/**
 * The adversarial gate: one report-only pass, and the finding text it left open.
 * `""` is the gate's clean pass. Anything else THROWS — a gate that produced no
 * verdict is not a gate that approved, and this one has no fixer of its own to
 * blame. The row this pass cost is APPENDED to the caller's running total, not
 * returned (see this file's header).
 */
export async function adversarialGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    head: string;
    branch: string;
    issueBody: string;
    round: number;
    rows: DispatchUsageRow[];
  },
): Promise<{ findings: string }> {
  let result: DispatchResult;
  try {
    result = await deps.adversarial({
      base: opts.base,
      head: opts.head,
      branch: opts.branch,
      cwd: ctx.repoRoot,
      issue: ctx.issue,
      issueBody: opts.issueBody,
      round: opts.round,
      headless: deps.headless,
    });
  } catch (err) {
    throw new ReviewInfraError(
      `the adversarial loop threw: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  opts.rows.push(dispatchUsageRow(result));
  if (result.loopOutcome === "approved") return { findings: openFromPass(result) };
  if (result.loopOutcome === "rejected") return { findings: result.text };
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
 * holds: if the round before left origin somewhere else, that is the fact the
 * next verdict should be stated against. Two gates reviewing two different
 * commits have reviewed neither.
 */
export async function lensGate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    branch: string;
    round: number;
    /** The run's PR number, threaded to the review layer rather than re-derived. */
    pr: number | undefined;
    carried: string | undefined;
    rows: DispatchUsageRow[];
  },
): Promise<LensRound & { head: string }> {
  const head = await reviewedHead(deps, ctx.repoRoot, opts.branch, opts.rows);
  const diff = await rangeDiff(deps, ctx.repoRoot, opts.base, head, opts.rows);
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
  // silently reports "no claims to check, no prose to supply", which is the
  // same shape as a clean scan. Same reason the frozen driver passes
  // `ps.branchName` (work-driver-lens.ts:158-165). `head` stays what the review
  // RANGES over; the branch is what these two read ON.
  const evidence = await buildEvidence(ctx.repoRoot, opts.branch, diff);
  const extraFindings = await runClaimScan(deps.exec, ctx.repoRoot, opts.branch, diff);
  let round: LensRound;
  try {
    round = await deps.lens({
      base: opts.base,
      head,
      branch: opts.branch,
      cwd: ctx.repoRoot,
      round: opts.round,
      pr: opts.pr,
      context: lensContext(ctx.issue, opts.round, {
        carried: opts.carried,
        fixDelta: delta.section,
      }),
      evidence,
      extraFindings,
      headless: deps.headless,
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
