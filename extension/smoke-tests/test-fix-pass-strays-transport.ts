#!/usr/bin/env bun
/**
 * #1849 — the revert's git TRANSPORT is the argv form, in production too.
 *
 * The field shape this pins: `revertStraysOnce` built its git adapter with
 * `runGit(ctx.verifyExecFn ?? defaultExec)`. `defaultExec` is the SHELL-STRING
 * form of `execp`, which ignores `opts.argv` — and `runGit` always calls with
 * argv. So every revert command was a bare `git`: usage on stderr, exit 129, and
 * the revert refused on its very first read. Every smoke test passed because
 * every test INJECTS `verifyExecFn`; in production that field is unset (it is a
 * test-only injection — see `work-driver-verify.ts`'s #476 note), so the
 * fallback is what production actually runs. The feature was dead outside tests
 * and no test could see it.
 *
 * So this file calls `revertStraysOnce` with NO `verifyExecFn` — the production
 * shape — against a real scratch repo under `.worktrees/`, and asserts the stray
 * is actually gone. It fails on the pre-#1849 line (verified against
 * /tmp/pi-ensemble-developer/revert-step.ts.bak) and passes with the argv
 * executor.
 */

import { existsSync, readFileSync } from "node:fs";
import type { PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import { revertStraysOnce } from "../src/work-driver-fix-pass-revert-step.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  passTreeAt,
  singleState,
  typedCycleCtx,
  typedPassPlans,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const post = (strays: string[], untracked: string[]): PostPass => ({
  diffs: {},
  admissions: [],
  straysFor: "default",
  strays: strays.map((file) => ({ file, refused: "no-slot" as const })),
  untracked,
});

/** Drive the step the fix pass drives, with the context a PRODUCTION caller
 *  builds: no `verifyExecFn`, so whatever transport the step falls back to is
 *  the one under test. */
async function revertWithProductionCtx(t: { repoRoot: string; worktree: string }) {
  const ctx = typedCycleCtx(t.repoRoot, 1846);
  const state: WorkState = singleState(t.worktree, []);
  const plans = await typedPassPlans(t.repoRoot, t.worktree, ["a.txt"], "a.txt: fix it");
  return revertStraysOnce(ctx, state, plans, post(["helper.ts", "b.txt"], []), 1);
}

console.log("# production transport: no verifyExecFn, a real .worktrees/ repo");
{
  const t = passTreeAt("1846-transport");
  const keptBefore = readFileSync(`${t.worktree}/a.txt`, "utf8");
  const outcome = await revertWithProductionCtx(t);
  assert(
    outcome?.ok === true,
    `the revert succeeds with NO injected executor (${JSON.stringify(outcome)})`,
  );
  assert(
    !existsSync(`${t.worktree}/helper.ts`),
    "the stray the pass created is GONE — the argv actually reached git, so a bare `git` never ran",
  );
  assert(
    readFileSync(`${t.worktree}/b.txt`, "utf8") === "one\n",
    "the edited stray is restored to its pre-pass content",
  );
  assert(
    readFileSync(`${t.worktree}/a.txt`, "utf8") === keptBefore,
    "and the pass's own fix is untouched",
  );
  assert(
    existsSync(`${t.repoRoot}/tmp/issue-1846/fix-pass-strays-untracked`) === false,
    "no untracked copy was made for a stray set with nothing untracked in it",
  );
  assert(
    outcome?.ok === true && readFileSync(outcome.event.patchPath, "utf8").length > 0,
    "the patch that records what the revert deleted was written",
  );
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
