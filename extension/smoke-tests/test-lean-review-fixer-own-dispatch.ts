#!/usr/bin/env bun
/**
 * lean/review — the FIXER's own dispatch still receives the clamped bound and the write fence.
 *
 * Split from `test-lean-review-fixer-bound.ts` along the grain that file already states: that file
 * asserts the CONTINUATION child (its argv, env, cwd, replay, bound); this one asserts the FIRST
 * child — what `runFixer` puts on the options its dispatch actually received. The two are different
 * subjects at different seams, and the second has the longer history.
 *
 * The defect these assertions hold shut is a shipped one, and it is why they are asserted on the
 * RECEIVED object rather than the value handed to the step: `runFixer` built its options as
 * `{ childBoundMs: FIX_BOUND_MS, writeFence: …, ...opts.budget.opts }`, so the spread RE-SUPPLIED the
 * budget's own `childBoundMs` — which `armBudget` sets from `budgets.review.minutes` — and
 * `FIX_BOUND_MS` was decoration: a 90-minute review budget bought a 90-minute fixer. An assertion on
 * the input passed with that bug present, because the input was correct and only the delivered value
 * was wrong. `test-lean-review-deps-bound.ts` is the same rule for the six lenses;
 * `test-lean-review-tree.ts` reads `a.budget.opts.childBoundMs`, the INPUT, so it cannot fail here —
 * and nothing else in the suite covers this seam. Mutant-verified in this change: `Math.min`→
 * `Math.max` fails four lines below, and dropping the `writeFence:` line fails the fence lines.
 *
 * The arms `armBudget` actually builds are `{ childBoundMs }` and nothing else (step-budget.ts), so
 * the clamp is the whole of what this step delivers from the budget. An abort signal and a progress
 * hook are NOT armed-budget arms for this step, so nothing here pretends to assert them — an
 * assertion on a value no production path can supply is green forever, which is the worse version of
 * the thing it looks like.
 *
 * Real temp repos, the production `armBudget` armed through `budgets.review`, stubbed model, no child
 * spawned, no token spent.
 */

import { writeFileSync } from "node:fs";
import { defaultConfig } from "../src/lean/config.ts";
import { FIX_BOUND_MS } from "../src/lean/review.ts";
import type { DispatchResult, DispatchSpec } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  type ReviewDeps,
  cleanupRoots,
  ctxFor,
  depsWith,
  git,
  makeRepo,
  rejectsThenClears,
  result,
  runStep as run,
  setup,
} from "./lib/lean-review-fixtures.ts";

const { assert, failures } = makeAssert();

// These four assertions are what this file asserted before the continuation existed, and the defect
// they hold shut is a shipped one (its own former jsdoc: “That is how it shipped”). `runFixer`
// built its options as `{ childBoundMs: FIX_BOUND_MS, writeFence: …, ...opts.budget.opts }`, so the
// budget's own `childBoundMs` — which `armBudget` sets from `budgets.review.minutes` — WON and the
// constant was decoration: a 90-minute review budget bought a 90-minute fixer. Deleting `...arms`
// or flipping `Math.min` to `Math.max` now has to fail HERE rather than ship.
//
// The arms `armBudget` actually builds are `{ childBoundMs }` and nothing else (step-budget.ts), so
// the clamp line is the whole of what this step delivers from the budget, and it is what the shipped
// defect got wrong. The abort signal and the progress hook are NOT armed-budget arms for this step,
// so this section does not pretend to assert them: an assertion on a value no production path can
// supply is green forever, which is the worse version of the thing it looks like.
// Real repo, real `armBudget` (via `budgets.review`), stubbed child, and every assertion on the
// SECOND ARGUMENT `deps.dispatch` actually received — captured off the call. The sibling suites
// cannot cover this: `test-lean-review-deps-bound.ts`'s `childBoundMs` greps are the LENS seam and
// `test-lean-review-tree.ts` reads `a.budget.opts.childBoundMs`, which is the INPUT and cannot fail.
{
  /** What one case drove, and what the fixer's dispatch was ACTUALLY handed.
   *
   * Nothing here wraps or re-supplies the object under test: every field the assertions read is one
   * `runFixer` put there, which is the delivered-vs-input distinction the section exists for. Mutant
   * verified — `Math.min`→`Math.max` in `runFixer` fails four of these lines, and dropping its
   * `writeFence:` line fails the fence lines. */
  async function deliver(budget: {
    minutes?: number;
    turns?: number;
    tokens?: number;
  }): Promise<{ delivered?: Record<string, unknown>; calls: number }> {
    const { repoRoot, baseSha } = makeRepo();
    await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
    const calls: Record<string, unknown>[] = [];
    const deps: ReviewDeps = depsWith({
      adversarial: rejectsThenClears("1. the finding the fixer will answer"),
      // Commits, so the round integrates and the step completes: a fixer whose round is refused
      // downstream never gets its options asserted on, because the step throws before the dispatch
      // that would have carried them.
      dispatch: async (spec: DispatchSpec, o: unknown) => {
        calls.push((o ?? {}) as Record<string, unknown>);
        const wt = (spec as { cwd: string }).cwd;
        writeFileSync(`${wt}/fix.ts`, `export const fixed = ${String(calls.length)};\n`);
        git(wt, "add", "-A");
        git(wt, "commit", "-q", "-m", `fix: the finding ${String(calls.length)}`);
        return result({ role: "developer" }) as DispatchResult;
      },
    });
    // The step arms its budget off `budgets.review` with the PRODUCTION `armBudget`, so the case
    // sets that knob rather than handing `runFixer` a hand-built `BudgetArms` — a fixture-built one
    // would be a second definition of what an armed budget is, and could agree with the fixture
    // while disagreeing with `armBudget`. `minutes: N` is what produces `childBoundMs: N * 60_000`.
    const cfg = defaultConfig();
    cfg.budgets.review = { turns: 0, tokens: 0, minutes: 0, ...budget };
    deps.loadConfig = async () => cfg;
    await run(ctxFor(repoRoot, baseSha, BRANCH), deps);
    return { delivered: calls[0], calls: calls.length };
  }

  const LOOSER = 90 * 60_000;
  const { delivered, calls } = await deliver({ minutes: 90 });
  assert(calls === 1, `(1) precondition: exactly one fixer was dispatched (${String(calls)})`);
  assert(
    delivered?.childBoundMs === FIX_BOUND_MS,
    `(1) THE CLAMP SURVIVES TO THE CALL: the fixer received the step's own ${String(
      FIX_BOUND_MS / 60_000,
    )}-minute bound, not the budget's 90 — the spread of the budget arms used to re-supply it and the constant was decoration (captured ${String(
      delivered?.childBoundMs,
    )})`,
  );
  assert(
    delivered?.childBoundMs !== LOOSER,
    `(1) and specifically NOT the budget's own bound, which is exactly what the delivered value was with the bug present (captured ${String(
      delivered?.childBoundMs,
    )})`,
  );

  // A budget TIGHTER than the fixer's ceiling still wins: the rule is a minimum, not a floor, or an
  // operator's run-level ceiling is silently overridden by a constant.
  const { delivered: tight } = await deliver({ minutes: 4 });
  assert(
    tight?.childBoundMs === 4 * 60_000,
    `(1) and a budget tighter than the fixer's ceiling still wins (captured ${String(
      tight?.childBoundMs,
    )}, expected ${String(4 * 60_000)})`,
  );

  // With no armed wall clock at all the child still gets its own bound — not `Infinity` (what a
  // dropped `?? Number.POSITIVE_INFINITY` gives) and not nothing.
  const { delivered: unbudgeted } = await deliver({});
  assert(
    unbudgeted?.childBoundMs === FIX_BOUND_MS,
    `(1) with no armed budget the fixer still gets its own bound, not Infinity and not undefined (captured ${String(
      unbudgeted?.childBoundMs,
    )})`,
  );

  // The FENCE still travels. The clamp is a change to the SAME object literal that carries the
  // fixer's write fence, and a fence that went missing with it would be the #1655 hole reopened by a
  // bound fix. Asserted on the fixer's own dispatch, because the continuation's fence is built by
  // the identical `fixWriteFence` expression — a regression in `runFixer`'s `writeFence:` line would
  // otherwise leave the continuation's fence green.
  const fence = (await deliver({ minutes: 90 })).delivered?.writeFence as
    | { root?: string; repo?: string; scratch?: string }
    | undefined;
  assert(
    typeof fence?.root === "string" && fence.root.includes(".worktrees"),
    `(1) and the fixer is still write-fenced to its own tree (${JSON.stringify(fence)})`,
  );
  assert(
    typeof fence?.repo === "string" && fence.repo.length > 0,
    "(1) and the fence still names the repo it is fenced against",
  );
  assert(
    typeof fence?.scratch === "string" && fence.scratch.includes("tmp/"),
    `(1) and it still names the run's scratch — the one field a hand-built second literal drifts (${JSON.stringify(
      fence?.scratch,
    )})`,
  );
}

cleanupRoots();
process.exit(failures());
