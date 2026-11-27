/**
 * lib/lean-step-bound-reason — the deadline's clause, asserted once and shared.
 *
 * #2660's surviving review finding: the clause `verdictReasonClause` composes for a step the
 * DEADLINE ended had one pinned site (build, in `test-lean-deadline-step-bound.ts` (c)). Its
 * body could be deleted and every other suite stayed green, because the three sibling callers
 * — challenge, specify's first child, specify's re-ask — had cases for the ARMS they hand out
 * but none for the REASON they print. This module states what those cases must demand; the
 * suites that use it are `test-lean-step-deadline-bound-sites.ts` (the arms each site hands its
 * dispatch) and `test-lean-step-deadline-bound-reasons.ts` (the reason each site prints).
 *
 * Both suites need the same row, the same pre-change golden, and the same kill cause, and the
 * line cap does not allow either suite to carry them twice.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PANEL_CELL_MS, PANEL_START_MS } from "./lean-step-bound-arms.ts";
import { GOLDEN_ALLOWANCE_MS, GOLDEN_GRACE_MS } from "./lean-step-deadline-bound-off-arm.ts";
import type { BudgetOpts } from "../../src/lean/step-budget.ts";

/** The field's panel cell: a 4200 s deadline and the instant its step was armed. */
export const DEADLINE = PANEL_START_MS + PANEL_CELL_MS;
export const AT = DEADLINE - 978_000;
/** What the deadline leaves the child of that row: room − allowance − the floored grace. */
export const EXPECT_BOUND = 468_000;
export const EXPECT_GRACE = 30_000;

/** The pre-change bound of a 45-minute row, straight out of the base-commit golden: what a site
 *  that never read the deadline hands out, and what every case refuses by name. */
export const PRE = (() => {
  const g = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "..", "fixtures", "lean-step-deadline-bound-off-arm.json"),
      "utf8",
    ),
  ) as { rows: Record<string, { opts: { childBoundMs?: number } }> };
  return g.rows["deadline/minutes=45/headless=false"]?.opts?.childBoundMs ?? 0;
})();

/** The env every site case pins, so no host default reaches the derivation. */
export const env = {
  PI_ENSEMBLE_HANDOFF_TIMEOUT_MS: String(GOLDEN_ALLOWANCE_MS),
  PI_ENSEMBLE_CHILD_BOUND_GRACE_MS: String(GOLDEN_GRACE_MS),
  PI_ENSEMBLE_DISPATCH_CAPS: "1",
};

/**
 * A child the deadline's bound ended: `applyChildBound` stamps the cause, and the child must not
 * look idle — an idle dead child is the provider-fault path, not the step's verdict.
 */
export const KILLED = { killCause: "child-bound" as const, ok: false, ms: EXPECT_BOUND };

/** The two assertions every site shares: the deadline's pair went out, the row's did not.
 *  `bound` is the row's own number: every case computes it from the instants IT states, and the
 *  arithmetic itself is `test-lean-deadline-step-bound.ts` (a)'s. */
export function assertDeadlineArms(
  assert: (cond: boolean, msg: string) => void,
  label: string,
  got: BudgetOpts | undefined,
  bound: number,
): void {
  assert(
    got?.childBoundMs === bound,
    `${label}: the child was bounded by the deadline (${String(bound)}), got ${String(got?.childBoundMs)}`,
  );
  assert(
    got?.childBoundGraceMs === (bound === EXPECT_BOUND ? EXPECT_GRACE : GOLDEN_GRACE_MS),
    `${label}: and its kill was armed ${String(bound === EXPECT_BOUND ? EXPECT_GRACE : GOLDEN_GRACE_MS)} ms behind the steer, got ${String(got?.childBoundGraceMs)}`,
  );
  assert(
    (got?.childBoundMs ?? 0) !== PRE,
    `${label}: and NOT the row's own bound (${String(PRE)}) — what a site that never read the deadline hands out`,
  );
}

/** AC3's other half, stated beside the arms: when the DEADLINE ended the child, the step's verdict
 *  reason must name it. Every site reaches that clause through ONE composer (`verdictReasonClause`,
 *  `lean-step-bound.ts`), so a site with no assertion here could have its clause deleted with every
 *  suite in the repo green — build's clause is pinned by `test-lean-deadline-step-bound.ts` (c),
 *  and these are the siblings of that case. */
export function assertDeadlineReason(
  assert: (cond: boolean, msg: string) => void,
  label: string,
  reason: string | undefined,
  state: string,
): void {
  assert(
    /the step stopped at the deadline, not its row/.test(reason ?? ""),
    `${label}: the budget verdict's reason names the DEADLINE as what ended the child, not only the minutes row (got ${JSON.stringify(reason)})`,
  );
  assert(
    new RegExp(`${state} stopped: minutes budget 45 exceeded`).test(reason ?? ""),
    `${label}: and it still carries the ceiling sentence the verdict always printed (got ${JSON.stringify(reason)})`,
  );
}
