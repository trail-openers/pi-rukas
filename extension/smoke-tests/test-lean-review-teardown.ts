#!/usr/bin/env bun
/**
 * lean/review — the fix-tree teardown is scoped to the ATTEMPT that made it.
 *
 * Split from `test-lean-review-tree.ts` along the seam that file states: those
 * cases create a tree and read it back, this one DESTROYS trees and asserts which
 * ones survived. The distinction is the defect — `closeFixTrees` runs in the step's
 * `finally`, and its selector decided which of two concurrent attempts kept a live
 * fix tree under a running fixer.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import fs from "node:fs";
import path from "node:path";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import {
  BRANCH,
  cleanupRoots,
  ctxFor,
  depsWith,
  fixRunId,
  setup,
  git,
  makeRepo,
} from "./lib/lean-review-fixtures.ts";
import { fixTreeName } from "../src/lean/review-tree.ts";

const { assert, failures } = makeAssert();

// ── (w) teardown is scoped to THIS attempt, not to every `-fix-` tree ──────
//
// `closeFixTrees` runs in the step's `finally` and used to tear down every attached
// worktree under `.worktrees/` whose name merely CONTAINED `-fix-`, ignoring the
// `attempt` entirely. Two attempts in flight — a resumed run, or a second cycle on
// the same issue — and one step's cleanup deleted the other's LIVE tree out from
// under a running fixer, so that child's `git commit` landed in a directory that had
// just been removed. The two trees below differ ONLY in attempt, which is exactly
// the shape a concurrent attempt has.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 6;\n" });
  const EPOCH = "1793451347919";
  const mine = fixTreeName(repoRoot, 7, "l", 1, 0, fixRunId(EPOCH));
  const sibling = fixTreeName(repoRoot, 7, "l", 1, 1, fixRunId(EPOCH));
  const otherIssue = fixTreeName(repoRoot, 8, "l", 1, 0, fixRunId(EPOCH));
  for (const wt of [mine, sibling, otherIssue]) {
    git(repoRoot, "worktree", "add", "--force", "--detach", wt, baseSha);
    assert(fs.existsSync(wt), `(w) precondition: ${path.basename(wt)} was created`);
  }
  const { closeFixTrees } = await import("../src/lean/review-tree.ts");
  const { depsWith: dw } = await import("./lib/lean-review-fixtures.ts");
  await closeFixTrees(dw({}), ctxFor(repoRoot, baseSha, BRANCH), 0, fixRunId(EPOCH));
  const gone = (wt: string) => !fs.existsSync(wt);
  assert(
    gone(mine),
    `(w) this attempt's own fix tree is gone — the teardown still does its job (survived: ${path.basename(mine)})`,
  );
  assert(
    fs.existsSync(sibling),
    `(w) A SIBLING ATTEMPT'S LIVE TREE SURVIVES the teardown: attempt 1's tree was not touched by attempt 0's step ending, which is the case the bare \`-fix-\` selector destroyed under a running fixer (${path.basename(sibling)})`,
  );
  assert(
    fs.existsSync(otherIssue),
    `(w) and another issue's fix tree survives too — the selector is this issue's, not the whole \`.worktrees\` dir (${path.basename(otherIssue)})`,
  );
  // And the attempt-scoped teardown must still clear its OWN round: a leftover from
  // a killed round of the same attempt is precisely what a resume must not adopt.
  const myRound2 = fixTreeName(repoRoot, 7, "a", 2, 0, fixRunId(EPOCH));
  git(repoRoot, "worktree", "add", "--force", "--detach", myRound2, baseSha);
  await closeFixTrees(dw({}), ctxFor(repoRoot, baseSha, BRANCH), 0, fixRunId(EPOCH));
  assert(
    gone(myRound2),
    `(w) and a second round of THIS attempt is still cleared, so the scope did not spare the leftover a resume would adopt (${path.basename(myRound2)})`,
  );
}
cleanupRoots();
process.exit(failures());
