#!/usr/bin/env bun
/**
 * lean/review-deps — the operator's lens bound survives the wiring (HIGH).
 *
 * `reviewDeps().lens` built the `runLensReview` options with
 * `childBoundMs: Math.min(budget, lensChildBoundMs())` and then spread
 * `...a.budget.opts` AFTER it. An object spread re-supplies keys, so the budget's
 * own `childBoundMs` WON and `PI_ENSEMBLE_LENS_BOUND_MS` silently did not apply: a
 * hung lens child ran to the generic bound and the knob was decoration.
 *
 * Every assertion here is on the value the seam ACTUALLY DELIVERED to the lens
 * engine, captured off the call — never on the value handed to `reviewDeps`. An
 * assertion on the input would have passed with this bug present, because the input
 * was correct in that bug and only what reached `runLensReview` was wrong. That is
 * how it shipped.
 *
 * No model, no child, no token: `lensEngine` is the one seam that stands in for the
 * six-lens pass.
 */

import { reviewDeps } from "../src/lean/review-deps.ts";
import { lensChildBoundMs } from "../src/spawn-child-bound.ts";
import type { BudgetArms } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** What one case drives, and what the lens engine was actually handed. */
async function deliver(
  env: Record<string, string | undefined>,
  budgetOpts: Record<string, unknown>,
): Promise<{ delivered?: Record<string, unknown>; calls: number }> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const calls: Record<string, unknown>[] = [];
  try {
    const deps = reviewDeps(false);
    deps.lensEngine = (async (opts: Record<string, unknown>) => {
      calls.push(opts);
      // `LensReviewSummary`'s shape, which is what the seam is called with: it
      // renders `findings` (objects, not the fixer's text) and folds `lenses` into
      // the round's usage. A round that ran no lens reports no usage, and nothing
      // here reads the verdict — inventing one would be a fixture agreeing with
      // itself.
      return {
        verdict: "APPROVED",
        findings: [],
        lenses: [],
        usage: undefined,
      } as never;
    }) as never;
    const budget = { opts: budgetOpts, fired: () => undefined } as unknown as BudgetArms;
    await deps.lens({
      base: "0123456789abcdef0123456789abcdef01234567",
      head: "0123456789abcdef0123456789abcdef01234568",
      branch: "lean/issue-7",
      cwd: "/tmp",
      round: 1,
      pr: undefined,
      context: "ctx",
      evidence: undefined,
      extraFindings: [],
      headless: false,
      budget,
    });
    return { delivered: calls[0], calls: calls.length };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ── (1) THE KNOB APPLIES. `PI_ENSEMBLE_LENS_BOUND_MS` below the budget's own bound
// must reach the lens call. With the bug the spread re-supplied the budget's larger
// value, so this is the assertion that separates the fix from the bug.
{
  const LENS_MS = 7 * 60_000;
  const BUDGET_MS = 15 * 60_000;
  const { delivered, calls } = await deliver(
    { PI_ENSEMBLE_LENS_BOUND_MS: String(LENS_MS) },
    { childBoundMs: BUDGET_MS },
  );
  assert(calls === 1, `(1) precondition: the lens engine was called once (${String(calls)})`);
  assert(
    delivered?.childBoundMs === LENS_MS,
    `(1) THE CLAMP SURVIVES TO THE CALL: the lens engine received the operator's PI_ENSEMBLE_LENS_BOUND_MS (${String(LENS_MS)}), not the budget's ${String(BUDGET_MS)} — the spread of the budget arms used to re-supply it and the knob was decoration (captured ${String(delivered?.childBoundMs)})`,
  );
  assert(
    delivered?.childBoundMs !== BUDGET_MS,
    `(1) and specifically NOT the budget's own bound, which is exactly what the delivered value was with the bug present (captured ${String(delivered?.childBoundMs)})`,
  );
}

// ── (2) THE BUDGET STILL TIGHTENS. The clamp is a min, so a budget below the
// operator's lens knob must win — otherwise "the smaller of the two is the bound"
// is a comment, and a global default could silently lengthen a budget the operator
// set for this run.
{
  const LENS_MS = 30 * 60_000;
  const BUDGET_MS = 4 * 60_000;
  const { delivered } = await deliver(
    { PI_ENSEMBLE_LENS_BOUND_MS: String(LENS_MS) },
    { childBoundMs: BUDGET_MS },
  );
  assert(
    delivered?.childBoundMs === BUDGET_MS,
    `(2) and the step's armed budget still TIGHTENS the bound below the lens knob (captured ${String(delivered?.childBoundMs)}, expected ${String(BUDGET_MS)})`,
  );
}

// ── (3) THE OTHER ARMS STILL TRAVEL. Taking `childBoundMs` out of the budget arms
// must not take the abort signal or the progress hook with it — a lens child with
// no signal is a child the turns/tokens levers cannot stop, which is the other half
// of the same budget and the half a naive "just delete the spread" would break.
{
  const controller = new AbortController();
  const onProgress = (): void => {};
  const { delivered } = await deliver(
    {},
    { childBoundMs: 9 * 60_000, signal: controller.signal, onProgress },
  );
  assert(
    delivered?.signal === controller.signal,
    "(3) the abort SIGNAL still reaches the lens call — destructure the arms correctly or the turns/tokens levers go dead with the clamp fix",
  );
  assert(
    delivered?.onProgress === onProgress,
    "(3) and so does the progress hook that fires the abort",
  );
  assert(
    delivered?.childBoundMs === Math.min(9 * 60_000, lensChildBoundMs()),
    `(3) and the bound is still the smaller of budget and knob (captured ${String(delivered?.childBoundMs)})`,
  );
}

// ── (4) NO BUDGET BOUND AT ALL still honours the knob, rather than handing the
// lens `Infinity` (which `?? Number.POSITIVE_INFINITY` would do if the min were
// dropped) or the generic default.
{
  const LENS_MS = 11 * 60_000;
  const { delivered } = await deliver({ PI_ENSEMBLE_LENS_BOUND_MS: String(LENS_MS) }, {});
  assert(
    delivered?.childBoundMs === LENS_MS,
    `(4) with no armed budget the lens still gets the operator's knob, not Infinity and not the generic bound (captured ${String(delivered?.childBoundMs)})`,
  );
}

process.exit(failures());
