#!/usr/bin/env bun
/**
 * lean/build — a stopped child that COMMITTED and then kept editing still folds
 * (#2113).
 *
 * The field shape: the builder wrote its file, committed it, carried on editing
 * that same file, and its ceiling ended the child with the edit uncommitted. The
 * fold's first mutation is the reset's checkout, and a plain
 * `git checkout -B <branch> <base>` refuses a tree holding an edit to a path the
 * move would have to rewrite ("Your local changes to the following files would
 * be overwritten by checkout"). Before the fix the `reset --hard` that would
 * have discarded the edit never ran, `normaliseBuild` threw `BuildInfraError`
 * "could not reset the worktree to …", and a routine budget stop handed the run
 * back at exit 10 instead of reporting its budget verdict.
 *
 * Split from `test-lean-build-budget-retry.ts` for the 500-line gate
 * (AGENTS.md §12); it is the same step and the same fixture, on the shape the
 * child leaves when it commits and then keeps working.
 */

import { emptyRunningState } from "../src/progress.ts";
import type { BudgetOpts } from "../src/lean/step-budget.ts";
import { MAX_BUILD_ATTEMPTS } from "../src/lean/machine.ts";
import type { WorkConfig } from "../src/lean/config.ts";
import { defaultConfig } from "../src/lean/config.ts";
import {
  commitPaths,
  configWithRunner,
  status,
  subjectsAbove,
} from "./lib/lean-build-asserts.ts";
import { ROOTS, buildFixture, childCommit, git, put, runBuild } from "./lib/lean-build-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/** One turn past a `turns: N` ceiling — the call `spawn.ts` makes at `message_end`. */
function breachTurns(turns: number) {
  return (onProgress: BudgetOpts["onProgress"]) =>
    onProgress?.({ ...emptyRunningState("developer"), turns: turns + 1 });
}

{
  const BUILD_TURNS = 3;
  const cfg: WorkConfig = {
    ...configWithRunner(),
    budgets: { ...defaultConfig().budgets, build: { turns: BUILD_TURNS, tokens: 0, minutes: 0 } },
  };
  // One child, because at the dispatch cap the loop runs the child its own round
  // paid for and buys no in-step retry: this case is about the fold, not the loop.
  const built = buildFixture(155);
  built.ctx.run.counters.buildAttempts = MAX_BUILD_ATTEMPTS;
  const stopped = await runBuild({
    issue: 155,
    built,
    config: cfg,
    child: (wt) => {
      put(wt, "src/retry.ts", "export const retry = () => { backoff(); };\n");
      childCommit(wt, "child: first cut");
      // The edit that must not survive, on the very path the child just committed.
      put(wt, "src/retry.ts", "export const retry = () => { backoff(3); };\n");
    },
    onProgressTick: breachTurns(BUILD_TURNS),
  });
  assert(
    stopped.threw === undefined,
    `(t) the fold of a committed-then-edited child does not throw: ${stopped.threw?.message?.split("\n")[0] ?? "clean"}`,
  );
  assert(
    stopped.outcome?.kind === "budget",
    `(t) the round reports its budget verdict (got ${stopped.outcome?.kind ?? "no outcome"})`,
  );
  assert(stopped.dispatched === 1, `(t) exactly one child ran (got ${stopped.dispatched})`);
  assert(
    subjectsAbove(stopped.worktree, stopped.headBefore).join() === "build: attempt 1 for #155",
    `(t) the child's work became one attempt commit on the head the step found (got ${subjectsAbove(stopped.worktree, stopped.headBefore).join(" | ") || "nothing"})`,
  );
  assert(
    git(stopped.worktree, "rev-parse", "HEAD^") === stopped.headBefore,
    "(t) that attempt commit's parent is the head the step found",
  );
  assert(
    commitPaths(stopped.worktree).join() === "src/retry.ts",
    `(t) the attempt commit holds the implementation (got ${commitPaths(stopped.worktree).join(", ")})`,
  );
  assert(
    status(stopped.worktree) === "",
    `(t) the tree is clean after the fold (got ${status(stopped.worktree)})`,
  );
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
