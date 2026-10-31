#!/usr/bin/env bun
/**
 * lean/review — the fixer's bound is the SMALLER of its ceiling and the budget.
 *
 * `runFixer` built its dispatch options as
 * `{ childBoundMs: FIX_BOUND_MS, writeFence: …, ...opts.budget.opts }`. An object
 * spread re-supplies keys, so the budget's own `childBoundMs` — which `armBudget`
 * sets from `budgets.review.minutes` — WON, and `FIX_BOUND_MS` was decoration: a
 * 90-minute review budget bought a 90-minute fixer. That is the identical defect
 * the lens leg of this same step fixed this round, and the lens leg's fix is the
 * shape mirrored here (destructure `childBoundMs` out of the arms and out of the
 * type, then take the smaller of the two).
 *
 * Every assertion is on the value `deps.dispatch` ACTUALLY RECEIVED, captured off
 * the call, never on the value handed to the step. An assertion on the input would
 * have passed with this bug present — the input was correct in that bug, and only
 * what reached the dispatch was wrong. That is how it shipped. `test-lean-review-
 * deps-bound.ts` is the same rule for the six lenses; this is the mirror for the
 * child this step pays the most for.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { FIX_BOUND_MS } from "../src/lean/review.ts";
import type { DispatchResult } from "../src/types.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  type ReviewDeps,
  FIXER_ROLE,
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
import { FIX_BOUND_MS } from "../src/lean/review.ts";

const { assert, failures } = makeAssert();

/**
 * A fixer that does its job, and records the options it was handed.
 *
 * The commit is what makes the round integrate: a fixer that commits nothing is
 * refused by `assertFixAdvanced` and the step throws before a second round's
 * dispatch would ever be observed. The options are captured on the way through, so
 * what the assertions read is what `runFixer` passed — not what a case passed.
 */
async function recordFixer(
  calls: Record<string, unknown>[],
  spec: { cwd?: string },
  o: unknown,
): Promise<DispatchResult> {
  calls.push((o ?? {}) as Record<string, unknown>);
  const wt = (spec as { cwd: string }).cwd;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${wt}/fix.ts`, `export const fixed = ${String(calls.length)};\n`);
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", `fix: the finding ${String(calls.length)}`);
  return result({ role: FIXER_ROLE }) as DispatchResult;
}

/** What one case drove, and what the dispatch seam was actually handed. */
async function deliver(
  budget: { minutes?: number; turns?: number; tokens?: number },
  extraArms: Record<string, unknown> = {},
): Promise<{
  delivered?: Record<string, unknown>;
  calls: number;
}> {
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const calls: Record<string, unknown>[] = [];
  const deps: ReviewDeps = depsWith({
    adversarial: rejectsThenClears("1. the finding the fixer will answer"),
    // Commits so the round integrates and the step completes: a fixer whose round
    // is refused downstream never gets its options asserted on, because the step
    // throws before the dispatch that would have carried them.
    dispatch: async (spec, o) => recordFixer(calls, spec, o),
  });
  // The step arms its budget off `budgets.review` with the production `armBudget`,
  // so the case sets that knob rather than handing `runFixer` a hand-built
  // `BudgetArms` — a fixture-built one would be a second definition of what an
  // armed budget is, and it could agree with the fixture while disagreeing with
  // `armBudget`. `minutes: N` is what produces `childBoundMs: N * 60_000`; turns
  // and tokens are 0 so the arms carry the bound alone unless a case adds them.
  const { defaultConfig } = await import("../src/lean/config.ts");
  const cfg = defaultConfig();
  cfg.budgets.review = { turns: 0, tokens: 0, minutes: 0, ...budget };
  cfg.budgets.review = { turns: 0, tokens: 0, minutes: 0, ...budget };
  deps.loadConfig = async () => cfg;
  if (Object.keys(extraArms).length > 0) {
    // The arms a case cannot get out of `armBudget` (a signal, a hook) are
    // supplied by wrapping the seam the step dispatches through: the arms the
    // fixer receives are still `runFixer`'s, and only what the clamp must not
    // touch is added here.
    const inner = deps.dispatch;
      // `extraArms` FIRST, so `runFixer`'s own object wins: an arm supplied this way
    // only fills a gap, and the value under test is never one the test wrote.
    deps.dispatch = async (spec, o) => inner(spec, { ...(o ?? {}), ...extraArms } as never);
  }
  await run(ctxFor(repoRoot, baseSha, BRANCH), deps);
  return { delivered: calls[0], calls: calls.length };
}

// ── (1) THE BUDGET CANNOT LENGTHEN THE FIXER'S BOUND — the defect itself.
//
// The budget is deliberately LOOSER than `FIX_BOUND_MS`, so a regression flips the
// captured number: with the spread in place the fixer was dispatched at the
// budget's 90 minutes, and the constant was never what the child ran under.
{
  const BUDGET_MS = 90 * 60_000;
  const { delivered, calls } = await deliver({ minutes: 90 });
  assert(calls === 1, `(1) precondition: exactly one fixer was dispatched (${String(calls)})`);
  assert(
    delivered?.childBoundMs === FIX_BOUND_MS,
    `(1) THE CLAMP SURVIVES TO THE CALL: the fixer received the step's own ${String(FIX_BOUND_MS / 60_000)}-minute bound, not the budget's ${String(BUDGET_MS / 60_000)} — the spread of the budget arms used to re-supply it and the constant was decoration (captured ${String(delivered?.childBoundMs)})`,
  );
  assert(
    delivered?.childBoundMs !== BUDGET_MS,
    `(1) and specifically NOT the budget's own bound, which is exactly what the delivered value was with the bug present (captured ${String(delivered?.childBoundMs)})`,
  );
}

// ── (2) THE BUDGET STILL TIGHTENS. The rule is a minimum, not a floor: a budget
// below the fixer's ceiling must win, or an operator's run-level ceiling is
// silently overridden by a constant.
{
  const BUDGET_MS = 4 * 60_000;
  const { delivered } = await deliver({ minutes: 4 });
  assert(
    delivered?.childBoundMs === BUDGET_MS,
    `(2) and a budget tighter than the fixer's ceiling still wins (captured ${String(delivered?.childBoundMs)}, expected ${String(BUDGET_MS)})`,
  );
}

// ── (3) THE OTHER ARMS STILL TRAVEL. Taking `childBoundMs` out of the arms must
// not take the abort signal or the progress hook with it — a fixer with no signal
// is a child the turns/tokens levers cannot stop, which is the other half of the
// same budget and the half a naive "just delete the spread" would break.
{
  const controller = new AbortController();
  const onProgress = (): void => {};
  const { delivered } = await deliver({ minutes: 90 }, { signal: controller.signal, onProgress });
  assert(
    delivered?.signal === controller.signal,
    "(3) the abort SIGNAL still reaches the fixer — destructure the arms correctly or the turns/tokens levers go dead with the clamp fix",
  );
  assert(
    delivered?.onProgress === onProgress,
    "(3) and so does the progress hook that fires the abort",
  );
  assert(
    delivered?.childBoundMs === FIX_BOUND_MS,
    `(3) and the bound is still the smaller of the two (captured ${String(delivered?.childBoundMs)})`,
  );
}

// ── (4) NO BUDGET BOUND AT ALL still honours the fixer's own ceiling, rather than
// handing the child `Infinity` (which a dropped `?? Number.POSITIVE_INFINITY`
// would) or nothing at all.
{
  const { delivered } = await deliver({});
  assert(
    delivered?.childBoundMs === FIX_BOUND_MS,
    `(4) with no armed budget the fixer still gets its own bound, not Infinity and not undefined (captured ${String(delivered?.childBoundMs)})`,
  );
}

// ── (5) THE FENCE STILL TRAVELS. The clamp is a change to the same object literal
// that carries the fixer's write fence, and a fence that went missing with it
// would be the #1655 hole reopened by a bound fix.
{
  const { delivered } = await deliver({ minutes: 90 });
  const fence = delivered?.writeFence as { root?: string; repo?: string } | undefined;
  assert(
    typeof fence?.root === "string" && fence.root.includes(".worktrees"),
    `(5) and the fixer is still write-fenced to its own tree (${JSON.stringify(fence)})`,
  );
  assert(
    typeof fence?.repo === "string" && fence.repo.length > 0,
    "(5) and the fence still names the repo it is fenced against",
  );
}

cleanupRoots();
process.exit(failures());
