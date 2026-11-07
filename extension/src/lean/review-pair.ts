/**
 * lean/review-pair — pass 1's two children, bought together, and what they owe
 * back before the step decides anything.
 *
 * Split from `review.ts` for the 500-line cap (AGENTS.md §12) along the seam this
 * change created: the step is the decision procedure (which verdict ends the wave,
 * what a fixer is told), and this is the ONE place that buys the full review's two
 * children. They were serialised — the gate was awaited, and its non-blocking
 * findings were printed into every lens brief — and the overlap is what makes the
 * step cheaper, so the ordering is the thing a reader must not have to re-derive
 * from a call site: it is stated here, in the module that owns it, once.
 *
 * Three rules the caller cannot see from the outside and cannot enforce itself:
 *
 * - **Both settle before this returns or throws** — on a clean pair, on a budget
 *   stop, and on a child that threw. `Promise.allSettled` is not incidental: a child
 *   the step has paid for is never left running while the step walks out around the
 *   other one's failure. A child's throw is raised only once both have settled, and
 *   the adapters that wrap it already carry the rows of every child the step paid
 *   for, so the handback can price what the step bought.
 * - **The budget is read before the verdict, for BOTH children.** The operator's
 *   ceiling ending the reviewer is a routed stop that the gate's own "no verdict"
 *   throw would otherwise report as infrastructure. The lever is the step's ONE
 *   armed `hit`, which whichever child tripped it writes, so the pair asks the arm
 *   itself once both have settled — not the gate's report alone: a child can trip
 *   the lever after the gate's last read and still hand back a clean result, and a
 *   pair that read only the gate would certify a head the operator's ceiling had
 *   already stopped. The breach is turned into the step's throw there, before either
 *   child's result is read for anything else, and because the step arms ONE budget
 *   for both children the lever is named once for the pair.
 * - **The rows are APPENDED to the caller's running total, never returned** — the
 *   rule both gate adapters already hold (see `review-gates.ts`'s header).
 */

import type { Severity } from "../lens-review-format.ts";
import type { DispatchResult } from "../types.ts";
import type { HandlerCtx } from "./engine.ts";
import type { LensRound, ReviewDeps } from "./review-args.ts";
import { type AdversarialGate, adversarialGate, lensGate } from "./review-gates.ts";
import { budgetStopped } from "./review-step.ts";
import type { BudgetArms, DispatchUsageRow } from "./step-budget.ts";

/**
 * What the budget arm is asked with, once both children have settled.
 *
 * `fired` needs a `DispatchResult` for one thing only — the `minutes` lever, which
 * it infers from a `killCause: "child-bound"`. A child the shared abort ended, or one
 * that answered normally, carries no such cause, so the stand-in below can only ever
 * reach the turns/tokens branch that reads the frozen `hit` and ignores the argument.
 * A real wall-clock breach is reported by the gate's own `stop` (the armed bound ends
 * the child that holds it and the adapter reads it), which is why the arm is asked
 * for the pair rather than the child.
 */
const BOTH_SETTLED: DispatchResult = {
  role: "review-pair",
  ok: true,
  text: "",
  toolUses: [],
  ms: 0,
  exitCode: 0,
};

/**
 * Buy pass 1's adversarial gate and six-lens round CONCURRENTLY and wait for both
 * to settle, then hand the step the two results.
 *
 * THROWS — the step's own infra error, with the rows the step paid for — on a child
 * that died, and on the operator's ceiling having ended one. Returns only when both
 * children have answered.
 *
 * The two children share nothing that has to be settled first. The lens round's
 * `carried` parameter was the only value that had them in series — the gate's
 * non-blocking findings, printed into every lens brief — and pass 1 passes it
 * `undefined`: the step reads the gate's blocking record before it decides
 * anything, and the findings that are not blocking reach the fixer's brief and the
 * re-review, which is where the step acts on them at all. A run whose gate is
 * non-blocking and whose lenses are clean has no brief and no re-review to carry
 * them to, and the review layer's residual post is the LENS round's — it fires on
 * an `ISSUES_FOUND` round only — so on that shape the step itself discloses the
 * gate's words: `review.ts` joins them into the pass reason through
 * `disclosureNote`, the surface the cleared wave already uses. Nothing is
 * undisclosed. What the overlap costs is that the six lenses never get to judge
 * those findings themselves — the gate had not answered when that round was
 * bought, and no brief could have said what it had not yet said.
 *
 * `lensGate` re-resolves origin for its own read and refuses a range it cannot
 * open, so the two gates disagreeing about the commit is a refusal rather than a
 * silent disagreement — which is what makes reading them at once safe.
 */
export async function buyFullReview(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    base: string;
    head: string;
    branch: string;
    issueBody: string;
    pr: number | undefined;
    threshold: Severity;
    rows: DispatchUsageRow[];
    budget: BudgetArms;
  },
): Promise<{
  gate: AdversarialGate & { findings: string; open: boolean; blocking: boolean };
  review: LensRound & { head: string };
}> {
  const { base, head, branch, issueBody, pr, threshold, rows, budget } = opts;
  const [gateSettled, lensSettled] = await Promise.allSettled([
    adversarialGate(deps, ctx, { base, head, branch, issueBody, wave: "full", rows, budget }),
    lensGate(deps, ctx, {
      base,
      branch,
      wave: "full",
      issueBody,
      pr,
      // Stated rather than omitted: pass 1 carries NOTHING to the lenses, because
      // the gate had not answered when this round was bought.
      carried: undefined,
      rows,
      budget,
      threshold,
    }),
  ]);
  // A ceiling that fired while the pair ran ends both children — they share the one
  // `AbortController` `armBudget` armed for the step — and the step names that lever
  // ONCE, here, with both children's rows on it. It is read off the ARM as well as
  // off the gate's report: `armBudget` freezes ONE `hit` for the step and the child
  // that trips it is whichever tipped the lever, so the arm answers for the lens
  // child too (`lensGate` has no stop arm of its own, and a lens child can trip the
  // lever after the gate's last read and still hand back a clean round). The gate's
  // own stop is the ordinary route, so it is read first. Read BEFORE the arms below:
  // the same abort that trips the lever can REJECT a child, and a child the operator's
  // ceiling killed is the operator's stop, not the adapters' infrastructure error.
  const lever =
    (gateSettled.status === "fulfilled" ? gateSettled.value.stop : undefined) ??
    budget.fired(BOTH_SETTLED);
  if (lever !== undefined) throw budgetStopped(lever, rows);
  // Neither child is in flight any more, so raising a throw now orphans nothing.
  // Both adapters wrap a dead child in the step's infra error carrying the rows.
  for (const settled of [gateSettled, lensSettled])
    if (settled.status === "rejected") throw settled.reason;
  if (gateSettled.status !== "fulfilled" || lensSettled.status !== "fulfilled")
    throw new Error(
      "the pass-1 pair produced no result from either gate — a gate that did not answer is not a gate that passed",
    );
  const gate = gateSettled.value;
  // Narrowed here rather than at the call site: the stop arm above threw, so the
  // findings the rest of the step reads are present. `open`/`blocking` are the
  // gate's own answers restated as the booleans the step reads, and `stop` is
  // pinned to `undefined` because a stopped gate never reaches this line — an
  // object spread of `gate` would otherwise carry the discarded union arm's `stop`
  // through.
  return {
    gate: {
      findings: gate.findings ?? "",
      open: gate.open === true,
      blocking: gate.blocking === true,
      stop: undefined,
    },
    review: lensSettled.value,
  };
}
